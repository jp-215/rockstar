import * as THREE from 'three';
import { CONFIG } from '../config';

export type PedState = 'walk' | 'glance' | 'stop' | 'enter' | 'inside_browse' | 'inside_counter' | 'leaving' | 'done';
export const INTERIOR_STATES: ReadonlySet<PedState> = new Set(['enter', 'inside_browse', 'inside_counter', 'leaving']);

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const SHIRTS = [0x3a6ea5, 0xc0392b, 0x27ae60, 0x8e44ad, 0xf39c12, 0x2c3e50, 0xecf0f1, 0x16a085, 0xd35400];
const PANTS = [0x2c3e50, 0x34495e, 0x1b2631, 0x5d6d7e, 0x4a235a];

let nextId = 1;

/** Low-poly pedestrian with a separately rotating head so gaze direction is visible. */
export class Pedestrian {
  readonly id = nextId++;
  readonly group = new THREE.Group();
  private head: THREE.Group;
  private ray: THREE.Line;
  private rayMat: THREE.LineBasicMaterial;
  private legL: THREE.Mesh; private legR: THREE.Mesh;
  private walkPhase = 0;

  x: number; z: number;
  readonly dir: 1 | -1;
  readonly laneZ: number;
  readonly laneIndex: number;
  readonly nearSide: boolean;
  readonly baseSpeed: number;
  speed: number;              // current forward speed
  heading: number;            // body yaw (rad), forward = (cos, 0, sin)
  headYaw: number;            // absolute head yaw (rad)
  readonly interest: number;  // 0..1 propensity to notice the storefront
  state: PedState = 'walk';
  stateTimer = 0;
  enteredStore = false;       // crossed the door at least once
  visitedStore = false;       // came back out; don't count or re-enter again
  purchased = false;
  enteredAt = 0;              // sim time when they walked in
  targets: THREE.Vector3[] = []; // waypoint queue used by interior states
  dwell = 0;                  // seconds remaining at the current spot
  lookRequested = false;      // behavior wants head toward focus point
  private umbrella: THREE.Group;

  constructor(opts: { x: number; dir: 1 | -1; laneZ: number; laneIndex: number; nearSide: boolean; speed: number; interest: number; pick: <T>(a: readonly T[]) => T }) {
    this.x = opts.x; this.z = opts.laneZ; this.dir = opts.dir; this.laneZ = opts.laneZ; this.laneIndex = opts.laneIndex;
    this.nearSide = opts.nearSide; this.baseSpeed = opts.speed; this.speed = opts.speed; this.interest = opts.interest;
    this.heading = opts.dir > 0 ? 0 : Math.PI; this.headYaw = this.heading;

    const skin = new THREE.MeshStandardMaterial({ color: opts.pick(SKIN), roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: opts.pick(SHIRTS), roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: opts.pick(PANTS), roughness: 0.9 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.5, 4, 8), shirt);
    torso.position.y = 1.15; torso.castShadow = true;
    this.legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.6, 3, 6), pants);
    this.legR = this.legL.clone();
    this.legL.position.set(0, 0.42, -0.1); this.legR.position.set(0, 0.42, 0.1);
    this.legL.castShadow = this.legR.castShadow = true;

    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 10), skin);
    skull.castShadow = true;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.05), skin);
    nose.position.set(0.13, -0.01, 0);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 10, 10, 0, Math.PI * 2, 0, Math.PI / 2.2), pants);
    hair.position.y = 0.01;
    this.head.add(skull, nose, hair);
    this.head.position.y = CONFIG.pedestrian.headHeight;
    this.group.add(torso, this.legL, this.legR, this.head);

    this.umbrella = new THREE.Group();
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.22, 8), new THREE.MeshStandardMaterial({ color: opts.pick([0x222222, 0x1d3f72, 0x7a1f1f, 0xdddddd, 0x1f5c2e]), roughness: 0.6, side: THREE.DoubleSide }));
    canopy.position.y = 2.05; canopy.castShadow = true;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 6), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    shaft.position.y = 1.55;
    this.umbrella.add(canopy, shaft);
    this.umbrella.position.set(0.1, 0, 0.15);
    this.umbrella.visible = false;
    this.group.add(this.umbrella);

    this.rayMat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.6 });
    const rg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, CONFIG.pedestrian.headHeight, 0), new THREE.Vector3(2.5, CONFIG.pedestrian.headHeight, 0)]);
    this.ray = new THREE.Line(rg, this.rayMat);
    this.head.add(this.ray);
    this.ray.position.y = -CONFIG.pedestrian.headHeight;

    this.syncTransform();
  }

  get forward(): THREE.Vector3 { return new THREE.Vector3(Math.cos(this.heading), 0, Math.sin(this.heading)); }
  headPosition(out = new THREE.Vector3()): THREE.Vector3 { return out.set(this.x, CONFIG.pedestrian.headHeight, this.z); }
  headForward(out = new THREE.Vector3()): THREE.Vector3 { return out.set(Math.cos(this.headYaw), 0, Math.sin(this.headYaw)); }

  /** True while behaviors.ts drives position directly (walking to / around / out of the store). */
  get selfMoving(): boolean { return INTERIOR_STATES.has(this.state); }
  get isInside(): boolean { return this.state === 'inside_browse' || this.state === 'inside_counter' || this.state === 'leaving'; }
  setUmbrella(v: boolean) { this.umbrella.visible = v && !this.isInside; }

  setLooking(looking: boolean) { this.rayMat.color.setHex(looking ? 0x2fe07a : 0x888888); this.rayMat.opacity = looking ? 1 : 0.5; }
  setRayVisible(v: boolean) { this.ray.visible = v; }

  /** Smoothly turn head toward a world point (or back to heading), with a human neck limit. */
  updateHead(dt: number, target: THREE.Vector3 | null) {
    let desired = this.heading;
    if (target) {
      const want = Math.atan2(target.z - this.z, target.x - this.x);
      let rel = wrap(want - this.heading);
      const limit = Math.PI * 0.55;
      rel = Math.max(-limit, Math.min(limit, rel));
      desired = this.heading + rel;
    }
    const d = wrap(desired - this.headYaw);
    const maxStep = CONFIG.pedestrian.headTurnRate * dt;
    this.headYaw += Math.max(-maxStep, Math.min(maxStep, d));
  }

  syncTransform() {
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = -this.heading;
    this.head.rotation.y = -wrap(this.headYaw - this.heading);
  }

  animate(dt: number) {
    this.walkPhase += dt * 7 * (this.speed / 1.3);
    const a = this.speed > 0.05 ? Math.sin(this.walkPhase) * 0.5 : 0;
    this.legL.rotation.z = a; this.legR.rotation.z = -a;
  }
}

export function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
