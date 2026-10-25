import * as THREE from 'three';
import { CONFIG } from '../config';

/** The virtual camera mounted above the shop door, looking out at the sidewalk. */
export class StorefrontCamera {
  readonly position: THREE.Vector3;
  readonly forward = new THREE.Vector3(0, 0, 1); // looks out across the sidewalk (+Z)
  readonly fovRad: number;
  readonly range: number;
  readonly helper = new THREE.Group();
  readonly viewCamera: THREE.PerspectiveCamera;

  constructor() {
    const C = CONFIG.camera;
    this.position = new THREE.Vector3(...C.position);
    this.fovRad = THREE.MathUtils.degToRad(C.fovDeg);
    this.range = C.range;

    // PiP camera for rendering what the storefront camera sees
    this.viewCamera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 60);
    this.viewCamera.position.copy(this.position);
    this.viewCamera.lookAt(this.position.x, 0.5, this.position.z + 6);

    // Physical camera body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.3), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4 }));
    body.position.copy(this.position);
    body.rotation.x = 0.4; body.layers.set(1); // hidden from the PiP camera
    this.helper.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 12), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    lens.rotation.x = Math.PI / 2 + 0.4;
    lens.position.copy(this.position).add(new THREE.Vector3(0, -0.06, 0.17)); lens.layers.set(1);
    this.helper.add(lens);

    // Ground wedge showing FOV × range
    const half = this.fovRad / 2;
    const pts: THREE.Vector3[] = [new THREE.Vector3(this.position.x, 0.2, this.position.z)];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const a = -half + (i / n) * this.fovRad;
      pts.push(new THREE.Vector3(this.position.x + Math.sin(a) * this.range, 0.2, this.position.z + Math.cos(a) * this.range));
    }
    pts.push(pts[0].clone());
    const wedge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffc34d }));
    this.helper.add(wedge);
    // edges from camera to wedge corners
    for (const i of [1, n + 1]) {
      const e = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.position.clone(), pts[i]]), new THREE.LineBasicMaterial({ color: 0xffc34d, transparent: true, opacity: 0.5 }));
      this.helper.add(e);
    }
  }

  /** Is a world point inside the camera's horizontal FOV and range? */
  sees(p: THREE.Vector3): boolean {
    const dx = p.x - this.position.x, dz = p.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d > this.range || d < 0.01) return false;
    const ang = Math.atan2(dx, dz); // angle from +Z forward
    return Math.abs(ang) <= this.fovRad / 2;
  }
}
