import * as THREE from 'three';
import { CONFIG } from '../config';
import { RNG } from '../util/rng';
import { Storefront } from '../world/storefront';
import { Pedestrian } from './pedestrian';
import { updateBehavior } from './behaviors';
import { AttentionEvent, EventBus } from '../manager/eventBus';

/** Spawns, steers, and despawns pedestrians on both sidewalks and inside the store. */
export class Crowd {
  readonly group = new THREE.Group();
  readonly peds: Pedestrian[] = [];
  spawnPerMin = CONFIG.sim.spawnPerMin;
  interestMul = 1;
  speedMul = 1;
  raining = false;
  showRays = true;
  onRemoved: ((p: Pedestrian) => void) | null = null;

  constructor(private rng: RNG, private storefront: Storefront, private bus: EventBus) {}

  get insideCount(): number { let n = 0; for (const p of this.peds) if (p.isInside) n++; return n; }

  private spawn() {
    const P = CONFIG.pedestrian, S = CONFIG.street;
    const nearSide = this.rng.chance(0.6);
    const lanes = nearSide ? S.lanes : S.farLanes;
    const laneIndex = Math.floor(this.rng.next() * lanes.length);
    const dir: 1 | -1 = this.rng.chance(0.5) ? 1 : -1;
    const p = new Pedestrian({
      x: -dir * P.spawnX + this.rng.range(-1, 1),
      dir, laneZ: lanes[laneIndex] + this.rng.range(-0.25, 0.25), laneIndex, nearSide,
      speed: this.rng.range(P.speedMin, P.speedMax) * this.speedMul,
      interest: Math.min(1, Math.max(CONFIG.behavior.minInterest, Math.pow(this.rng.next(), 1.4) * this.interestMul)),
      pick: (a) => this.rng.pick(a),
    });
    p.setRayVisible(this.showRays && nearSide);
    p.setUmbrella(this.raining && this.rng.chance(0.75));
    this.peds.push(p);
    this.group.add(p.group);
  }

  setRaysVisible(v: boolean) { this.showRays = v; for (const p of this.peds) p.setRayVisible(v && p.nearSide); }
  setRaining(v: boolean) { this.raining = v; for (const p of this.peds) p.setUmbrella(v && p.id % 4 !== 0); }

  update(dt: number, t: number) {
    const expected = (this.spawnPerMin / 60) * dt;
    if (this.rng.chance(expected)) this.spawn();

    const P = CONFIG.pedestrian;
    const peds = this.peds;
    const emit = (e: AttentionEvent) => this.bus.emit(e);

    for (const p of peds) {
      const wasInside = p.isInside;
      const target = updateBehavior(p, dt, { rng: this.rng, storefront: this.storefront, t, emit });
      if (!p.selfMoving && p.state !== 'done') {
        p.x += Math.cos(p.heading) * p.speed * dt;
        p.z += (p.laneZ - p.z) * Math.min(1, 1.5 * dt);
      }
      if (wasInside !== p.isInside) p.setUmbrella(this.raining && p.id % 4 !== 0);
      p.updateHead(dt, target);
    }

    // Separation on the sidewalk only (interior movement is waypoint-driven)
    const sep = P.separationDist, sep2 = sep * sep;
    for (let i = 0; i < peds.length; i++) {
      const a = peds[i];
      if (a.selfMoving || a.state === 'done') continue;
      for (let j = i + 1; j < peds.length; j++) {
        const b = peds[j];
        if (b.selfMoving || b.state === 'done' || a.nearSide !== b.nearSide) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > sep2 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (sep - d) / sep;
        const nz = dz / d || (a.id < b.id ? 1 : -1);
        const k = 1.5 * push * dt;
        if (a.state !== 'stop') a.z -= nz * k;
        if (b.state !== 'stop') b.z += nz * k;
        if (Math.abs(dz) < 0.45) {
          if (a.dir === 1 && dx > 0 && a.state === 'walk') a.speed = Math.min(a.speed, Math.max(0.2, b.speed * 0.9));
          if (a.dir === -1 && dx < 0 && a.state === 'walk') a.speed = Math.min(a.speed, Math.max(0.2, b.speed * 0.9));
          if (b.dir === 1 && dx < 0 && b.state === 'walk') b.speed = Math.min(b.speed, Math.max(0.2, a.speed * 0.9));
          if (b.dir === -1 && dx > 0 && b.state === 'walk') b.speed = Math.min(b.speed, Math.max(0.2, a.speed * 0.9));
        }
      }
    }

    const S = CONFIG.street;
    for (let i = peds.length - 1; i >= 0; i--) {
      const p = peds[i];
      const bounds = p.nearSide ? S.sidewalkNearZ : S.sidewalkFarZ;
      if (!p.selfMoving) p.z = Math.max(bounds[0] + 0.4, Math.min(bounds[1] - 0.4, p.z));
      p.animate(dt);
      p.syncTransform();
      if (p.state === 'done' || Math.abs(p.x) > P.despawnX) {
        this.onRemoved?.(p);
        this.group.remove(p.group);
        peds.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const p of this.peds) this.group.remove(p.group);
    this.peds.length = 0;
  }
}
