import * as THREE from 'three';
import { CONFIG } from '../config';
import { Pedestrian } from '../agents/pedestrian';
import { EventBus } from '../manager/eventBus';
import { Storefront } from '../world/storefront';
import { AttentionDetector } from './detector';
import { StorefrontCamera } from './storefrontCamera';

interface Track {
  looking: boolean;
  candidateMs: number;   // time continuously inside the gaze cone (pre-threshold)
  lostMs: number;        // time continuously outside the cone while "looking"
  gazeStartT: number;
  totalDwellMs: number;
  everLooked: boolean;
  stillMs: number;
  stopReported: boolean;
  wasInZone: boolean;
  exitReported: boolean;
}

/** Reads head direction straight from the simulation and applies a cone + debounce test. */
export class GroundTruthDetector implements AttentionDetector {
  private tracks = new Map<number, Track>();
  private cone: number;
  private tmpHead = new THREE.Vector3();
  private tmpFwd = new THREE.Vector3();
  private tmpTo = new THREE.Vector3();
  lookingCount = 0;

  constructor(private camera: StorefrontCamera, private storefront: Storefront, private bus: EventBus) {
    this.cone = THREE.MathUtils.degToRad(CONFIG.camera.gazeConeDeg);
  }

  reset() { this.tracks.clear(); this.lookingCount = 0; }
  isLooking(id: number) { return this.tracks.get(id)?.looking ?? false; }

  private track(p: Pedestrian): Track {
    let t = this.tracks.get(p.id);
    if (!t) {
      t = { looking: false, candidateMs: 0, lostMs: 0, gazeStartT: 0, totalDwellMs: 0, everLooked: false, stillMs: 0, stopReported: false, wasInZone: false, exitReported: false };
      this.tracks.set(p.id, t);
    }
    return t;
  }

  update(t: number, dt: number, peds: readonly Pedestrian[]) {
    const C = CONFIG.camera;
    const dtMs = dt * 1000;
    let count = 0;
    for (const p of peds) {
      if (!p.nearSide || p.isInside) continue;
      const tr = this.track(p);
      const head = p.headPosition(this.tmpHead);
      const visible = this.camera.sees(head);
      let inCone = false;
      if (visible) {
        const fwd = p.headForward(this.tmpFwd);
        const to = this.tmpTo.subVectors(this.storefront.focusPoint, head); to.y = 0; to.normalize();
        inCone = Math.acos(THREE.MathUtils.clamp(fwd.dot(to), -1, 1)) <= this.cone;
      }

      if (!tr.looking) {
        tr.candidateMs = inCone ? tr.candidateMs + dtMs : 0;
        if (tr.candidateMs >= C.minGazeMs) {
          tr.looking = true; tr.lostMs = 0; tr.gazeStartT = t - tr.candidateMs / 1000; tr.everLooked = true;
          this.bus.emit({ type: 'gaze_start', t, pedId: p.id, x: p.x, lane: p.laneIndex });
        }
      } else {
        tr.lostMs = inCone ? 0 : tr.lostMs + dtMs;
        if (tr.lostMs >= C.hysteresisMs) {
          this.endGaze(t - tr.lostMs / 1000, p.id, tr);
        } else {
          // stop-and-look: looking while stationary for a sustained moment
          tr.stillMs = p.speed < 0.15 ? tr.stillMs + dtMs : 0;
          if (!tr.stopReported && tr.stillMs > 800) {
            tr.stopReported = true;
            this.bus.emit({ type: 'stop_and_look', t, pedId: p.id, x: p.x });
          }
        }
      }
      if (tr.looking) count++;
      p.setLooking(tr.looking);

      // zone bookkeeping (passed by without entering)
      const inZone = this.storefront.inZone(p.x, p.z);
      if (inZone) tr.wasInZone = true;
      else if (tr.wasInZone && !tr.exitReported && !p.selfMoving && !p.enteredStore && p.state !== 'done') {
        this.reportExit(t, p, tr);
      }
    }
    this.lookingCount = count;
  }

  private endGaze(t: number, pedId: number, tr: Track) {
    const dwellMs = Math.max(0, (t - tr.gazeStartT) * 1000);
    tr.totalDwellMs += dwellMs;
    tr.looking = false; tr.candidateMs = 0; tr.lostMs = 0; tr.stillMs = 0;
    this.bus.emit({ type: 'gaze_end', t, pedId, dwellMs });
  }

  private reportExit(t: number, p: Pedestrian, tr: Track) {
    tr.exitReported = true;
    this.bus.emit({ type: 'zone_exit', t, pedId: p.id, looked: tr.everLooked, totalDwellMs: tr.totalDwellMs, lane: p.laneIndex });
  }

  onPedestrianRemoved(t: number, p: Pedestrian) {
    const tr = this.tracks.get(p.id);
    if (!tr) return;
    if (tr.looking) this.endGaze(t, p.id, tr);
    // Visitors are already counted via 'entered' / 'left_store'; only pure passersby get a zone_exit here.
    if (!p.enteredStore && tr.wasInZone && !tr.exitReported) this.reportExit(t, p, tr);
    this.tracks.delete(p.id);
  }
}
