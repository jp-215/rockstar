import * as THREE from 'three';
import { CONFIG } from '../config';
import { RNG } from '../util/rng';
import { Storefront } from '../world/storefront';
import { Pedestrian } from './pedestrian';
import { AttentionEvent } from '../manager/eventBus';

export interface BehaviorCtx { rng: RNG; storefront: Storefront; t: number; buyMul: number; emit: (e: AttentionEvent) => void; }

/**
 * Sidewalk interest model + interior visit model.
 * Sidewalk: inside the attention zone each pedestrian rolls per second for glance / stop / enter,
 * scaled by interest × storefront attractiveness. Interior: door → browse spot(s) → maybe counter
 * (purchase) → door → back onto the sidewalk. Returns the point the head should look at, if any.
 */
export function updateBehavior(p: Pedestrian, dt: number, ctx: BehaviorCtx): THREE.Vector3 | null {
  const B = CONFIG.behavior, I = CONFIG.interior;
  const sf = ctx.storefront;
  const focus = sf.focusPoint;

  p.stateTimer -= dt;
  switch (p.state) {
    case 'walk': {
      p.speed = approach(p.speed, p.baseSpeed, 3 * dt);
      const inZone = p.nearSide && !p.visitedStore && sf.inZone(p.x, p.z);
      const ahead = (focus.x - p.x) * p.dir > -3.5;
      if (inZone && ahead) {
        const drive = p.interest * sf.attractiveness;
        const enterOdds = B.enterRatePerSec * drive * dt * (p.interest > 0.6 ? 1.6 : 0.6) * (1 + sf.conversionLift);
        if (ctx.rng.chance(enterOdds)) {
          beginEnter(p, sf);
        } else if (ctx.rng.chance(B.stopRatePerSec * drive * dt)) {
          p.state = 'stop'; p.stateTimer = ctx.rng.range(B.stopDur[0], B.stopDur[1]); p.lookRequested = true;
        } else if (ctx.rng.chance(B.glanceRatePerSec * drive * dt)) {
          p.state = 'glance'; p.stateTimer = ctx.rng.range(B.glanceDur[0], B.glanceDur[1]); p.lookRequested = true;
        }
      }
      return null;
    }
    case 'glance': {
      p.speed = approach(p.speed, p.baseSpeed * 0.85, 3 * dt);
      const ahead = (focus.x - p.x) * p.dir > -3.5;
      if (p.stateTimer <= 0 || !ahead) { p.state = 'walk'; p.lookRequested = false; return null; }
      return focus;
    }
    case 'stop': {
      p.speed = approach(p.speed, 0, 4 * dt);
      if (p.stateTimer <= 0) {
        if (ctx.rng.chance(0.25 + 0.5 * sf.attractiveness * p.interest + sf.conversionLift * 0.5)) beginEnter(p, sf);
        else { p.state = 'walk'; p.lookRequested = false; return null; }
      }
      return focus;
    }
    case 'enter': {
      if (followTargets(p, dt, 1.0)) {
        // crossed the threshold
        p.enteredStore = true; p.enteredAt = ctx.t;
        ctx.emit({ type: 'entered', t: ctx.t, pedId: p.id, totalDwellMs: 0 });
        p.state = 'inside_browse';
        p.targets = [pt(sf.doorInner), pt(ctx.rng.pick(sf.browsePoints))];
        p.dwell = ctx.rng.range(I.browseDur[0], I.browseDur[1]);
        p.stateTimer = 1; // allow one extra browse hop
      }
      return focus;
    }
    case 'inside_browse': {
      if (followTargets(p, dt, I.walkSpeed)) {
        p.dwell -= dt;
        if (p.dwell <= 0) {
          if (p.stateTimer > 0 && ctx.rng.chance(I.secondBrowseChance)) {
            p.stateTimer = 0;
            p.targets = [pt(ctx.rng.pick(sf.browsePoints))];
            p.dwell = ctx.rng.range(I.browseDur[0], I.browseDur[1]);
          } else if (ctx.rng.chance((I.buyBase + 0.4 * p.interest) * ctx.buyMul + sf.conversionLift)) {
            p.state = 'inside_counter';
            p.targets = [pt(sf.counterPoint)];
            p.dwell = ctx.rng.range(I.counterDur[0], I.counterDur[1]);
          } else {
            beginLeave(p, sf);
          }
        }
        return p.targets.length ? null : lookAround(p, ctx.t);
      }
      return null;
    }
    case 'inside_counter': {
      if (followTargets(p, dt, I.walkSpeed)) {
        p.dwell -= dt;
        if (p.dwell <= 0) {
          p.purchased = true;
          ctx.emit({ type: 'purchased', t: ctx.t, pedId: p.id });
          beginLeave(p, sf);
        }
        return sf.counterFocus;
      }
      return null;
    }
    case 'leaving': {
      if (followTargets(p, dt, I.walkSpeed)) {
        ctx.emit({ type: 'left_store', t: ctx.t, pedId: p.id, insideSec: ctx.t - p.enteredAt, purchased: p.purchased });
        p.visitedStore = true;
        p.state = 'walk';
        p.heading = p.dir > 0 ? 0 : Math.PI;
        p.headYaw = p.heading;
        p.speed = 0.3;
      }
      return null;
    }
    case 'done':
      return null;
  }
}

function beginEnter(p: Pedestrian, sf: Storefront) {
  p.state = 'enter'; p.lookRequested = true;
  p.targets = [pt(sf.doorPoint)];
}

function beginLeave(p: Pedestrian, sf: Storefront) {
  p.state = 'leaving';
  p.targets = [pt(sf.doorInner), pt(sf.doorPoint), new THREE.Vector3(sf.doorPoint.x + p.dir * 1.2, 0, p.laneZ)];
}

const pt = (v: THREE.Vector3 | [number, number]) => Array.isArray(v) ? new THREE.Vector3(v[0], 0, v[1]) : v.clone();

/** Walk toward the head of the target queue. Returns true when the queue is empty (arrived). */
function followTargets(p: Pedestrian, dt: number, speed: number): boolean {
  if (p.targets.length === 0) { p.speed = 0; return true; }
  const tgt = p.targets[0];
  const dx = tgt.x - p.x, dz = tgt.z - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.25) { p.targets.shift(); return p.targets.length === 0; }
  p.heading = Math.atan2(dz, dx);
  p.speed = approach(p.speed, speed, 3 * dt);
  const step = Math.min(dist, p.speed * dt);
  p.x += (dx / dist) * step; p.z += (dz / dist) * step;
  return false;
}

const tmpLook = new THREE.Vector3();
function lookAround(p: Pedestrian, t: number): THREE.Vector3 {
  const a = p.heading + Math.sin(t * 0.7 + p.id) * 0.8;
  return tmpLook.set(p.x + Math.cos(a) * 2, 1.4, p.z + Math.sin(a) * 2);
}

function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  return v + Math.max(-maxDelta, Math.min(maxDelta, d));
}
