import * as THREE from 'three';

/** Simple rain streaks: line segments that fall and wrap around a box over the block. */
export class Rain {
  readonly object: THREE.LineSegments;
  private pos: Float32Array;
  private speeds: Float32Array;
  private count: number;
  private box = { x: [-48, 48], y: [0, 26], z: [-20, 22] };
  enabled = false;

  constructor(count = 2200) {
    this.count = count;
    this.pos = new Float32Array(count * 6);
    this.speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.reset(i, Math.random() * (this.box.y[1] - this.box.y[0]));
      this.speeds[i] = 9 + Math.random() * 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbfd3e6, transparent: true, opacity: 0.45 }));
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  private reset(i: number, y: number) {
    const x = this.box.x[0] + Math.random() * (this.box.x[1] - this.box.x[0]);
    const z = this.box.z[0] + Math.random() * (this.box.z[1] - this.box.z[0]);
    const o = i * 6;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.pos[o + 3] = x + 0.06; this.pos[o + 4] = y + 0.45; this.pos[o + 5] = z;
  }

  setEnabled(v: boolean) { this.enabled = v; this.object.visible = v; }

  update(dt: number) {
    if (!this.enabled) return;
    for (let i = 0; i < this.count; i++) {
      const o = i * 6, dy = this.speeds[i] * dt, dx = 1.2 * dt;
      this.pos[o + 1] -= dy; this.pos[o + 4] -= dy; this.pos[o] += dx; this.pos[o + 3] += dx;
      if (this.pos[o + 1] < 0) this.reset(i, this.box.y[1]);
    }
    (this.object.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
