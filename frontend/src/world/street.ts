import * as THREE from 'three';
import { CONFIG } from '../config';
import { RNG } from '../util/rng';

const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });

function box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = shadow; mesh.receiveShadow = true;
  return mesh;
}

export interface Street { group: THREE.Group; setNight(f: number): void; }

/** Builds one block of Market Street. The storefront itself is added separately. */
export function buildStreet(rng: RNG): Street {
  const g = new THREE.Group();
  const lampLights: THREE.PointLight[] = [];
  const lampMats: THREE.MeshStandardMaterial[] = [];
  const S = CONFIG.street;
  const L = S.length;

  // Ground / road
  const road = box(L, 0.1, S.roadZ[1] - S.roadZ[0], mat(0x3a3a3f), 0, -0.05, (S.roadZ[0] + S.roadZ[1]) / 2, false);
  g.add(road);
  // Muni-style rails + brick median strip
  const railM = mat(0x8c8c8c, { metalness: 0.6, roughness: 0.4 });
  for (const z of [3.2, 4.6, 6.2, 7.6]) g.add(box(L, 0.04, 0.08, railM, 0, 0.02, z, false));
  g.add(box(L, 0.03, 2.2, mat(0x7a4b3a), 0, 0.015, 5.4, false));
  // Lane dashes
  const dashM = mat(0xdedede);
  for (let x = -L / 2; x < L / 2; x += 4) g.add(box(2, 0.02, 0.12, dashM, x, 0.03, 0.6, false));
  for (let x = -L / 2; x < L / 2; x += 4) g.add(box(2, 0.02, 0.12, dashM, x, 0.03, 10.2, false));

  // Sidewalks (grey granite-ish pavers) and curbs
  const paveM = mat(0x9a9a94);
  const near = box(L, 0.16, S.sidewalkNearZ[1] - S.sidewalkNearZ[0], paveM, 0, 0.08, (S.sidewalkNearZ[0] + S.sidewalkNearZ[1]) / 2, false);
  const far = box(L, 0.16, S.sidewalkFarZ[1] - S.sidewalkFarZ[0], paveM, 0, 0.08, (S.sidewalkFarZ[0] + S.sidewalkFarZ[1]) / 2, false);
  g.add(near, far);
  const curbM = mat(0xb8b8b2);
  g.add(box(L, 0.18, 0.25, curbM, 0, 0.09, S.sidewalkNearZ[1] + 0.1, false));
  g.add(box(L, 0.18, 0.25, curbM, 0, 0.09, S.sidewalkFarZ[0] - 0.1, false));

  // Buildings: near side (skip the storefront slot), far side continuous
  const palette = [0xb9a58f, 0xa38f7b, 0xc8bba6, 0x8e8275, 0xd1c3ad, 0x9c8e80];
  const slot = CONFIG.storefront;
  const slotMin = slot.centerX - slot.width / 2, slotMax = slot.centerX + slot.width / 2;
  const addFacadeRow = (zFront: number, depth: number, dir: 1 | -1, skip: [number, number] | null) => {
    let x = -L / 2;
    while (x < L / 2) {
      const w = rng.range(7, 14);
      const x0 = x, x1 = Math.min(x + w, L / 2);
      x = x1;
      if (skip && x1 > skip[0] && x0 < skip[1]) {
        // split around the storefront slot
        if (x0 < skip[0]) addBuilding(x0, skip[0], zFront, depth, dir);
        if (x1 > skip[1]) addBuilding(skip[1], x1, zFront, depth, dir);
        continue;
      }
      addBuilding(x0, x1, zFront, depth, dir);
    }
  };
  const addBuilding = (x0: number, x1: number, zFront: number, depth: number, dir: 1 | -1) => {
    const w = x1 - x0; if (w < 1) return;
    const floors = Math.floor(rng.range(3, 7));
    const h = floors * 3.6;
    const m = mat(rng.pick(palette));
    const cx = (x0 + x1) / 2, cz = zFront + dir * depth / 2;
    g.add(box(w - 0.15, h, depth, m, cx, h / 2, cz));
    // windows
    const winM = mat(0x3b4a5c, { metalness: 0.3, roughness: 0.2, emissive: 0x111a26 });
    const cols = Math.max(1, Math.floor(w / 2.4));
    for (let f = 0; f < floors; f++) for (let c = 0; c < cols; c++) {
      const wx = x0 + (c + 0.5) * (w / cols);
      const wy = f * 3.6 + 2.0;
      g.add(box(1.2, 1.7, 0.1, winM, wx, wy, zFront - dir * 0.06, false));
    }
    // ground-floor storefront strip (other shops)
    const shopM = mat(rng.pick([0x5c3b2e, 0x2e4a5c, 0x3d5c2e, 0x5c2e4a]));
    g.add(box(w - 0.15, 0.6, 0.12, shopM, cx, 3.3, zFront - dir * 0.08, false));
    g.add(box(w - 0.15, 2.6, 0.08, mat(0x1d2730, { metalness: 0.2, roughness: 0.3 }), cx, 1.4, zFront - dir * 0.09, false));
  };
  addFacadeRow(slot.facadeZ, 14, -1, [slotMin, slotMax]);
  addFacadeRow(S.sidewalkFarZ[1], 14, 1, null);

  // Lamp posts and trees along near sidewalk
  const poleM = mat(0x2b2f36, { metalness: 0.5, roughness: 0.5 });
  const leafM = mat(0x4b7a3a);
  for (let x = -L / 2 + 6; x < L / 2; x += 12) {
    const pole = box(0.14, 5, 0.14, poleM, x, 2.5, S.sidewalkNearZ[1] - 0.6);
    g.add(pole);
    const lampMat = mat(0xffe9b8, { emissive: 0xffd080, emissiveIntensity: 0.6 });
    lampMats.push(lampMat);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 12), lampMat);
    lamp.position.set(x, 5.1, S.sidewalkNearZ[1] - 0.6);
    g.add(lamp);
    if (Math.abs(x) <= 34) {
      const pl = new THREE.PointLight(0xffd080, 0, 16, 1.6);
      pl.position.set(x, 5.0, S.sidewalkNearZ[1] - 0.6);
      g.add(pl); lampLights.push(pl);
    }
    if (Math.abs(x - slot.centerX) > slot.width) {
      const tx = x + 6;
      g.add(box(0.25, 2.4, 0.25, mat(0x5a4332), tx, 1.2, S.sidewalkNearZ[1] - 0.9));
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), leafM);
      crown.position.set(tx, 3.3, S.sidewalkNearZ[1] - 0.9); crown.castShadow = true;
      g.add(crown);
    }
  }
  // Far sidewalk lamps
  for (let x = -L / 2 + 2; x < L / 2; x += 12) {
    g.add(box(0.14, 5, 0.14, poleM, x, 2.5, S.sidewalkFarZ[0] + 0.6));
  }
  return {
    group: g,
    setNight(f: number) {
      for (const l of lampLights) l.intensity = 45 * f;
      for (const m of lampMats) m.emissiveIntensity = 0.6 + 2.5 * f;
    },
  };
}
