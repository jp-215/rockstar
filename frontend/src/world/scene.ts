import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LightPreset } from '../config';

interface Preset { sky: number; fog: [number, number]; sun: number; sunColor: number; sunPos: [number, number, number]; hemi: number; ground: number; exposure: number; night: number }
const PRESETS: Record<LightPreset, Preset> = {
  day:      { sky: 0x9fb8d6, fog: [60, 160], sun: 2.2, sunColor: 0xfff1dc, sunPos: [30, 40, 20], hemi: 0.9, ground: 0x60564a, exposure: 1.0, night: 0 },
  overcast: { sky: 0x7d8792, fog: [25, 100], sun: 0.5, sunColor: 0xcfd6dd, sunPos: [10, 40, 10], hemi: 0.75, ground: 0x4a4a4a, exposure: 0.85, night: 0.25 },
  dusk:     { sky: 0xd98a62, fog: [50, 150], sun: 1.3, sunColor: 0xffb070, sunPos: [-45, 9, 25], hemi: 0.45, ground: 0x3a2f2a, exposure: 1.0, night: 0.7 },
  night:    { sky: 0x0a1020, fog: [30, 110], sun: 0.08, sunColor: 0x8aa0ff, sunPos: [-20, 30, -10], hemi: 0.12, ground: 0x0a0a10, exposure: 1.0, night: 1 },
};

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  /** 0 = full daylight, 1 = night; consumers use it to switch on street lamps. */
  nightFactor = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x9fb8d6);
    this.scene.fog = new THREE.Fog(0x9fb8d6, 60, 160);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    this.camera.layers.enable(1); // layer 1 = helpers hidden from the storefront PiP camera
    this.camera.position.set(-18, 14, 16);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.5, -5);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.enableDamping = true;

    const hemi = this.hemi = new THREE.HemisphereLight(0xdfe9ff, 0x60564a, 0.9);
    this.scene.add(hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(30, 40, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -50; sc.right = 50; sc.top = 40; sc.bottom = -30; sc.near = 1; sc.far = 120;
    this.scene.add(sun);

    this.resize(container);
    new ResizeObserver(() => this.resize(container)).observe(container);
  }

  applyLighting(preset: LightPreset) {
    const p = PRESETS[preset];
    (this.scene.background as THREE.Color).setHex(p.sky);
    const fog = this.scene.fog as THREE.Fog; fog.color.setHex(p.sky); fog.near = p.fog[0]; fog.far = p.fog[1];
    this.sun.intensity = p.sun; this.sun.color.setHex(p.sunColor); this.sun.position.set(...p.sunPos);
    this.hemi.intensity = p.hemi; this.hemi.groundColor.setHex(p.ground);
    this.renderer.toneMappingExposure = p.exposure;
    this.nightFactor = p.night;
  }

  private resize(container: HTMLElement) {
    const w = container.clientWidth, h = container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
