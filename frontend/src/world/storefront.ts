import * as THREE from 'three';
import { CONFIG } from '../config';

export interface StorefrontKnobs {
  signBrightness: number; // 0..1
  awning: boolean;
  windowDisplay: boolean;
  aFrame: boolean;
}

export type CampaignColor = 'red' | 'teal' | 'gold' | 'black';
export interface Campaign {
  active: boolean;
  headline: string;
  subline: string;
  color: CampaignColor;
  poster: boolean;   // in the display window
  banner: boolean;   // above the sign
  aFrame: boolean;   // printed on the sidewalk A-frame
}

const PALETTE: Record<CampaignColor, { bg: string; fg: string; accent: string }> = {
  red:   { bg: '#c0392b', fg: '#fff6ee', accent: '#ffd166' },
  teal:  { bg: '#0f6e74', fg: '#f2fbfb', accent: '#ffd166' },
  gold:  { bg: '#f2c14e', fg: '#2b1d0e', accent: '#c0392b' },
  black: { bg: '#141414', fg: '#f5f5f5', accent: '#f2c14e' },
};

const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });

/** The business under observation: facade, hollow interior, campaign surfaces, focus/zone geometry. */
export class Storefront {
  readonly group = new THREE.Group();
  readonly focusPoint: THREE.Vector3;
  readonly doorPoint: THREE.Vector3;     // just outside the door
  readonly doorInner: THREE.Vector3;     // just inside the door
  readonly counterPoint: THREE.Vector3;
  readonly counterFocus: THREE.Vector3;
  readonly browsePoints: THREE.Vector3[];
  readonly zone: { xMin: number; xMax: number; zMin: number; zMax: number };
  knobs: StorefrontKnobs = { signBrightness: 0.4, awning: false, windowDisplay: false, aFrame: false };
  campaign: Campaign = { active: false, headline: 'Happy Hour 4–6', subline: 'Half-price small plates', color: 'red', poster: true, banner: true, aFrame: true };

  private signMat: THREE.MeshStandardMaterial;
  private signLight: THREE.PointLight;
  private awning: THREE.Group;
  private display: THREE.Group;
  private aFrame: THREE.Group;
  private aFrameFace: THREE.MeshStandardMaterial;
  private aFrameDefaultTex: THREE.CanvasTexture;
  private zoneMesh: THREE.Mesh;
  private banner: THREE.Mesh;
  private bannerMat: THREE.MeshStandardMaterial;
  private screenMat: THREE.MeshBasicMaterial;
  private screenIdleTex: THREE.CanvasTexture;
  private screenLight: THREE.PointLight;

  constructor() {
    const S = CONFIG.storefront;
    const z = S.facadeZ;
    const halfW = S.width / 2;
    this.focusPoint = new THREE.Vector3(S.centerX, S.focusHeight, z + 0.1);
    this.doorPoint = new THREE.Vector3(S.doorX, 0, z + 0.7);
    this.doorInner = new THREE.Vector3(S.doorX, 0, z - 0.9);
    this.counterPoint = new THREE.Vector3(S.counter[0], 0, S.counter[1]);
    this.counterFocus = new THREE.Vector3(S.counter[0], 1.3, S.counter[1] - 1.2);
    this.browsePoints = S.browsePoints.map(([x, zz]) => new THREE.Vector3(x, 0, zz));
    this.zone = { xMin: S.centerX - S.zoneHalfWidth, xMax: S.centerX + S.zoneHalfWidth, zMin: CONFIG.street.sidewalkNearZ[0], zMax: CONFIG.street.sidewalkNearZ[1] };

    const g = this.group;
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, zz: number, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); mesh.position.set(x, y, zz); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
    };

    // ---------- Upper floors (hidden in interior view) ----------
    const upper = new THREE.Group();
    const upH = 3 * 3.6;
    box(S.width - 0.15, upH, 14, std(0xc9a27a), S.centerX, 3.6 + upH / 2, z - 7, upper);
    for (let f = 1; f < 4; f++) for (let c = 0; c < 3; c++) {
      box(1.3, 1.8, 0.1, std(0x3b4a5c, { metalness: 0.3, roughness: 0.2 }), S.centerX - 2.8 + c * 2.8, f * 3.6 + 2, z + 0.06, upper);
    }
    g.add(upper);

    // ---------- Ground floor shell: thin walls so both faces render ----------
    const depth = S.depth;
    const backZ = z - depth;
    const wallM = std(0xe8e0d2);
    const trimM = std(0x24303a);
    box(0.15, 3.6, 14, std(0xc9a27a), S.centerX - halfW + 0.07, 1.8, z - 7);    // left exterior wall
    box(0.15, 3.6, 14, std(0xc9a27a), S.centerX + halfW - 0.07, 1.8, z - 7);    // right exterior wall
    box(S.width, 3.6, 4, std(0xc9a27a), S.centerX, 1.8, backZ - 2);              // back-of-house block
    box(S.width - 0.3, 3.6, 0.15, wallM, S.centerX, 1.8, backZ + 0.07);          // back wall (interior face)
    const floor = box(S.width - 0.3, 0.1, depth, std(0x6b4a33, { roughness: 0.6 }), S.centerX, 0.05, z - depth / 2);
    floor.castShadow = false;
    box(S.width - 0.3, 0.1, depth, std(0xf4f1ea), S.centerX, 3.55, z - depth / 2).castShadow = false;
    // Front wall pieces: left pier | window | pier | door opening | right pier
    const winX0 = S.centerX - halfW + 0.5, winX1 = S.doorX - 2.2;
    const doorW = 1.4, doorX0 = S.doorX - doorW / 2, doorX1 = S.doorX + doorW / 2;
    const piece = (x0: number, x1: number, y0: number, y1: number) => box(x1 - x0, y1 - y0, 0.2, trimM, (x0 + x1) / 2, (y0 + y1) / 2, z + 0.1);
    piece(S.centerX - halfW, winX0, 0, 3.6);
    piece(winX0, winX1, 0, 0.45);              // kneewall under window
    piece(winX0, winX1, 3.0, 3.6);             // lintel over window
    piece(winX1, doorX0, 0, 3.6);              // pier between window and door
    piece(doorX0, doorX1, 2.6, 3.6);           // header over door
    piece(doorX1, S.centerX + halfW, 0, 3.6);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc4d9, transmission: 0.7, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    box(winX1 - winX0, 2.55, 0.04, glass, (winX0 + winX1) / 2, 1.725, z + 0.1).castShadow = false;
    // Door leaf, swung open inward against the pier
    const leaf = box(0.06, 2.5, doorW - 0.05, std(0x7a3b2a), doorX1 - 0.05, 1.3, z - doorW / 2 + 0.05);
    leaf.castShadow = true;
    box(0.1, 0.1, 0.1, std(0xd9b24a, { metalness: 0.8, roughness: 0.3 }), doorX1 - 0.1, 1.1, z - doorW + 0.3);

    // ---------- Interior: window platform, counter, shelves, tables, lights ----------
    const platform = box(winX1 - winX0 - 0.2, 0.5, 1.2, std(0x4a3a2c), (winX0 + winX1) / 2, 0.25, z - 0.7);
    platform.castShadow = false;
    const counterZ = S.counter[1] - 0.9;
    box(6, 1.0, 0.7, std(0x3d2b1f, { roughness: 0.5 }), S.centerX, 0.5, counterZ);           // counter
    box(6, 0.06, 0.8, std(0xd8c7a8, { roughness: 0.3 }), S.centerX, 1.03, counterZ);         // countertop
    box(6, 2.2, 0.12, std(0x8a6a4a), S.centerX, 2.3, backZ + 0.2);                            // back bar panel
    for (const sy of [1.45, 2.05, 2.65]) box(6, 0.05, 0.45, std(0xd8c7a8), S.centerX, sy, backZ + 0.42); // shelves
    const bottleColors = [0x7bd389, 0xf2c14e, 0xe66f6f, 0x6fb7e6, 0xffffff];
    for (let i = 0; i < 14; i++) { const bh = 0.3 + (i % 3) * 0.08; box(0.12, bh, 0.12, std(bottleColors[i % 5], { emissive: bottleColors[i % 5], emissiveIntensity: 0.2 }), S.centerX - 2.6 + i * 0.4, 1.475 + bh / 2 + (i % 2) * 0.6, backZ + 0.42); }
    // menu board above the bar
    const menuTex = makeTextTexture('MENU', 'coffee · plates · wine', PALETTE.black, 512, 192);
    const menu = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), std(0xffffff, { map: menuTex, emissive: 0xffffff, emissiveMap: menuTex, emissiveIntensity: 0.4 }));
    menu.position.set(S.centerX, 2.95, backZ + 0.16); g.add(menu);
    box(0.5, 0.6, 0.4, std(0xaaaaaa, { metalness: 0.7, roughness: 0.3 }), S.centerX + 1.8, 1.36, counterZ); // register / espresso machine
    // Left wall display shelves (browse spots -3.2,-10.5 and -3.2,-13.5 face them)
    for (const sz of [-10.5, -13.5]) {
      box(0.4, 1.8, 1.8, std(0x5a4332), S.centerX - halfW + 0.35, 0.9, sz);
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++)
        box(0.25, 0.25, 0.25, std(bottleColors[(k + j) % 5]), S.centerX - halfW + 0.45, 0.35 + k * 0.55, sz - 0.55 + j * 0.55);
    }
    // Right side café tables (browse spots 2.6,-11 and 2.6,-14 stand beside them)
    for (const tz of [-11, -14]) {
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 16), std(0xd8c7a8)); top.position.set(3.5, 0.75, tz); top.castShadow = true; g.add(top);
      box(0.08, 0.72, 0.08, std(0x333333), 3.5, 0.36, tz);
      for (const cz of [tz - 0.7, tz + 0.7]) { box(0.4, 0.05, 0.4, std(0x333333), 3.5, 0.45, cz); box(0.4, 0.5, 0.05, std(0x333333), 3.5, 0.7, cz + (cz > tz ? 0.18 : -0.18)); }
    }
    // Rug under the center browse spot
    const rug = box(2.6, 0.02, 2.0, std(0x8a3b3b), 0.2, 0.11, -12.8); rug.castShadow = false;
    // Ceiling lights
    for (const [lx, lz] of [[-2, z - 3], [2, z - 7]]) {
      const lamp = new THREE.PointLight(0xffe6c4, 18, 10, 1.8); lamp.position.set(lx, 3.3, lz); g.add(lamp);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.05, 12), std(0xffffff, { emissive: 0xffe6c4, emissiveIntensity: 1.5 })); disc.position.set(lx, 3.48, lz); g.add(disc);
    }

    // ---------- Sign ----------
    this.signMat = std(0xff6a3d, { emissive: 0xff6a3d, emissiveIntensity: 0.4 });
    box(S.width - 1.5, 0.7, 0.15, this.signMat, S.centerX, 3.95, z + 0.25);
    box(S.width - 1.3, 0.85, 0.1, std(0x1a1a1a), S.centerX, 3.95, z + 0.16);
    this.signLight = new THREE.PointLight(0xff8a5d, 0, 10, 2);
    this.signLight.position.set(S.centerX, 4.2, z + 1.2);
    g.add(this.signLight);

    // ---------- Awning (toggle) ----------
    this.awning = new THREE.Group();
    const awn = new THREE.Mesh(new THREE.BoxGeometry(S.width - 1.2, 0.08, 1.8), std(0xb8342a));
    awn.position.set(S.centerX, 3.45, z + 1.0); awn.rotation.x = 0.25; awn.castShadow = true;
    this.awning.add(awn);
    for (const sx of [-1, 1]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 2.0), std(0x222222));
      strut.position.set(S.centerX + sx * (S.width / 2 - 0.8), 3.25, z + 1.0); strut.rotation.x = 0.25;
      this.awning.add(strut);
    }
    for (let i = -3; i <= 3; i += 2) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.09, 1.8), std(0xf3ebdd));
      stripe.position.set(S.centerX + i * 1.0, 3.455, z + 1.0); stripe.rotation.x = 0.25;
      this.awning.add(stripe);
    }
    g.add(this.awning);

    // ---------- Window display (toggle) ----------
    this.display = new THREE.Group();
    const colors = [0xf2c14e, 0x4ea5f2, 0xf25c4e, 0x7bd389, 0xe66fd2];
    for (let i = 0; i < 5; i++) {
      const hgt = 0.4 + (i % 3) * 0.3;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, hgt, 0.5), std(colors[i], { emissive: colors[i], emissiveIntensity: 0.25 }));
      m.position.set(winX0 + 0.5 + i * 0.6, 0.5 + hgt / 2, z - 0.7); m.castShadow = true;
      this.display.add(m);
    }
    const spot = new THREE.SpotLight(0xffffff, 40, 6, 0.6, 0.5, 1.5);
    spot.position.set((winX0 + winX1) / 2, 3.3, z - 0.5);
    spot.target.position.set((winX0 + winX1) / 2, 0.6, z - 0.7);
    this.display.add(spot, spot.target);
    g.add(this.display);

    // ---------- A-frame sidewalk sign (toggle; campaign can print on it) ----------
    this.aFrame = new THREE.Group();
    this.aFrameDefaultTex = makeTextTexture('OPEN', 'come on in', PALETTE.gold, 256, 384);
    this.aFrameFace = std(0xffffff, { map: this.aFrameDefaultTex, emissive: 0xffffff, emissiveMap: this.aFrameDefaultTex, emissiveIntensity: 0.25 });
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.04), s > 0 ? [std(0x1f1f1f), std(0x1f1f1f), std(0x1f1f1f), std(0x1f1f1f), this.aFrameFace, std(0x1f1f1f)] : std(0x1f1f1f));
      panel.position.set(S.centerX - 3.5, 0.6, z + 2.2 + s * 0.18); panel.rotation.x = s * -0.35; panel.castShadow = true;
      this.aFrame.add(panel);
    }
    g.add(this.aFrame);

    // ---------- Storefront TV: portrait 9:16 screen standing in the display window ----------
    const tvW = 0.9, tvH = 1.6, tvX = winX1 - 0.9, tvZ = z - 0.45;
    const bezel = box(tvW + 0.06, tvH + 0.06, 0.06, std(0x111111, { roughness: 0.4, metalness: 0.3 }), tvX, 0.5 + tvH / 2 + 0.03, tvZ);
    bezel.castShadow = true;
    box(0.5, 0.04, 0.3, std(0x111111), tvX, 0.52, tvZ + 0.05);   // stand
    this.screenIdleTex = makeTextTexture('Market St. Café', 'coffee · plates · wine', PALETTE.black, 540, 960);
    this.screenMat = new THREE.MeshBasicMaterial({ map: this.screenIdleTex, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(tvW, tvH), this.screenMat);
    screen.position.set(tvX, 0.5 + tvH / 2 + 0.03, tvZ + 0.031);
    g.add(screen);
    this.screenLight = new THREE.PointLight(0xffffff, 3, 4, 2);
    this.screenLight.position.set(tvX, 1.4, tvZ + 0.4);
    g.add(this.screenLight);

    // ---------- Campaign banner above the sign ----------
    this.bannerMat = std(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.3, side: THREE.DoubleSide });
    this.banner = new THREE.Mesh(new THREE.PlaneGeometry(S.width - 1.6, 0.9), this.bannerMat);
    this.banner.position.set(S.centerX, 5.1, z + 0.35);
    g.add(this.banner);
    for (const sx of [-1, 1]) box(0.05, 1.1, 0.05, std(0x222222), S.centerX + sx * (S.width / 2 - 0.9), 5.1, z + 0.33);

    // ---------- Attention zone ----------
    const zg = new THREE.PlaneGeometry(this.zone.xMax - this.zone.xMin, this.zone.zMax - this.zone.zMin);
    this.zoneMesh = new THREE.Mesh(zg, new THREE.MeshBasicMaterial({ color: 0x4fc27a, transparent: true, opacity: 0.12, depthWrite: false }));
    this.zoneMesh.rotation.x = -Math.PI / 2;
    this.zoneMesh.position.set((this.zone.xMin + this.zone.xMax) / 2, 0.17, (this.zone.zMin + this.zone.zMax) / 2);
    g.add(this.zoneMesh);

    this.applyKnobs(this.knobs);
    this.applyCampaign(this.campaign);
  }

  /** 0..1 — how eye-catching the storefront is right now (knobs + live campaign). */
  get attractiveness(): number {
    const k = this.knobs, c = this.campaign, C = CONFIG.campaign;
    let a = 0.15 + 0.3 * k.signBrightness + (k.awning ? 0.2 : 0) + (k.windowDisplay ? 0.25 : 0) + (k.aFrame ? 0.1 : 0);
    if (c.active) a += (c.poster ? C.posterLift : 0) + (c.banner ? C.bannerLift : 0);
    return Math.min(1, a);
  }

  /** Extra enter/buy propensity from a live campaign. */
  get conversionLift(): number { return this.campaign.active ? CONFIG.campaign.conversionLift : 0; }

  applyKnobs(k: StorefrontKnobs) {
    this.knobs = { ...k };
    this.signMat.emissiveIntensity = 0.2 + k.signBrightness * 2.5;
    this.signLight.intensity = k.signBrightness * 20;
    this.awning.visible = k.awning;
    this.display.visible = k.windowDisplay;
    this.aFrame.visible = k.aFrame;
  }

  applyCampaign(c: Campaign) {
    this.campaign = { ...c };
    const pal = PALETTE[c.color];
    const show = c.active && c.headline.trim().length > 0;
    this.banner.visible = show && c.banner;
    if (show) {
      const bannerTex = makeTextTexture(c.headline, c.subline, pal, 1024, 128, true);
      this.bannerMat.map?.dispose(); this.bannerMat.map = bannerTex; this.bannerMat.emissiveMap = bannerTex;
      this.bannerMat.needsUpdate = true;
    }
    const afTex = show && c.aFrame ? makeTextTexture(c.headline, c.subline, pal, 256, 384) : this.aFrameDefaultTex;
    if (this.aFrameFace.map !== afTex && this.aFrameFace.map !== this.aFrameDefaultTex) this.aFrameFace.map?.dispose();
    this.aFrameFace.map = afTex; this.aFrameFace.emissiveMap = afTex; this.aFrameFace.needsUpdate = true;
  }

  /** Put a 1080×1920 campaign image on the storefront TV; null returns it to the idle menu screen. */
  setScreenImage(url: string | null) {
    if (!url) { this.screenMat.map = this.screenIdleTex; this.screenMat.needsUpdate = true; this.screenLight.intensity = 3; return; }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      if (this.screenMat.map && this.screenMat.map !== this.screenIdleTex) this.screenMat.map.dispose();
      this.screenMat.map = tex; this.screenMat.needsUpdate = true; this.screenLight.intensity = 8;
    });
  }
  setZoneVisible(v: boolean) { this.zoneMesh.visible = v; }
  inZone(x: number, z: number): boolean {
    return x >= this.zone.xMin && x <= this.zone.xMax && z >= this.zone.zMin && z <= this.zone.zMax;
  }
}

/** Renders headline + subline onto a canvas texture. */
function makeTextTexture(headline: string, subline: string, pal: { bg: string; fg: string; accent: string }, w: number, h: number, wide = false): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = pal.accent; ctx.lineWidth = Math.max(4, w * 0.012); ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = pal.fg;
  const fit = (text: string, maxW: number, size: number) => { ctx.font = `bold ${size}px system-ui, sans-serif`; while (ctx.measureText(text).width > maxW && size > 10) { size -= 2; ctx.font = `bold ${size}px system-ui, sans-serif`; } return size; };
  if (wide) {
    fit(headline, w * 0.55, h * 0.6);
    ctx.fillText(headline, w * 0.33, h / 2);
    ctx.fillStyle = pal.accent; fit(subline, w * 0.32, h * 0.38);
    ctx.fillText(subline, w * 0.78, h / 2);
  } else {
    fit(headline, w * 0.88, h * 0.22);
    ctx.fillText(headline, w / 2, h * 0.42);
    ctx.fillStyle = pal.accent; fit(subline, w * 0.85, h * 0.12);
    ctx.fillText(subline, w / 2, h * 0.66);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
