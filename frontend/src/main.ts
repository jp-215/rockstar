import * as THREE from 'three';
import { CONFIG, ScenarioId } from './config';
import { RNG } from './util/rng';
import { SceneRig } from './world/scene';
import { buildStreet } from './world/street';
import { Storefront } from './world/storefront';
import { Rain } from './world/weather';
import { Crowd } from './agents/crowd';
import { StorefrontCamera } from './sensing/storefrontCamera';
import { GroundTruthDetector } from './sensing/groundTruthDetector';
import { AttentionDetector } from './sensing/detector';
import { EventBus } from './manager/eventBus';
import { Metrics } from './manager/metrics';
import { AlertEngine } from './manager/alerts';
import { DebugFlags, Panel, ViewMode } from './manager/panel';
import { MeshClient } from './mesh/meshClient';
import { HTTP_BASE } from '../../shared/mesh-types';

const container = document.getElementById('view')!;
const pipLabel = document.getElementById('pip')!;
const rig = new SceneRig(container);

// Static world (seeded so facades are stable across resets)
const street = buildStreet(new RNG(12345));
rig.scene.add(street.group);
const storefront = new Storefront();
rig.scene.add(storefront.group);
const cam = new StorefrontCamera();
rig.scene.add(cam.helper);
const rain = new Rain();
rig.scene.add(rain.object);

// Dynamic parts, rebuilt on reset
const bus = new EventBus();
const metrics = new Metrics(bus, storefront.zone);
const alerts = new AlertEngine();
let crowd: Crowd;
let detector: AttentionDetector;
let simTime = 0;
let seed = 1;
let paused = false;
let speed = 1;
let scenario: ScenarioId = 'regular';
let spawnPerMin = CONFIG.scenarios.regular.spawnPerMin;
let view: ViewMode = 'external';
let debug: DebugFlags = { rays: true, frustum: true, zone: true, pip: true };

bus.on((e) => console.debug('[attention]', e));

// ---- Mesh link: footfall batches + purchases out, display/promo + scenario control in ----
const mesh = new MeshClient('sim');
const foot = { passersby: 0, lookers: 0, walkIns: 0, lastT: 0 };
bus.on((e) => {
  if (e.type === 'zone_exit') { foot.passersby++; if (e.looked) foot.lookers++; }
  else if (e.type === 'entered') { foot.passersby++; foot.lookers++; foot.walkIns++; }
  else if (e.type === 'purchased') mesh.publish('sim.purchased', { simTime: e.t, pedId: e.pedId });
});
const WEATHER: Record<string, 'clear' | 'rain' | 'overcast' | 'night'> = { regular: 'clear', rainy: 'rain', rush: 'clear', dead: 'night' };
function flushFootfall() {
  mesh.publish('sim.footfall', { simTime, scenario, weather: WEATHER[scenario] ?? 'clear', passersby: foot.passersby, lookers: foot.lookers, walkIns: foot.walkIns, windowSec: simTime - foot.lastT });
  foot.passersby = foot.lookers = foot.walkIns = 0; foot.lastT = simTime;
}
const meshBadge = document.getElementById('t-mesh')!;
let meshProvider = '–';
const renderMeshBadge = () => { meshBadge.textContent = mesh.connected ? `agents on · ${meshProvider}` : 'agents offline — start the backend'; meshBadge.style.color = mesh.connected ? '#7ee2a8' : '#f88'; };
mesh.onConnection = renderMeshBadge;
mesh.on('mesh.status', (e) => { meshProvider = `${e.payload.provider} · ${e.payload.imageProvider}${e.payload.online ? '' : ' · offline'}`; renderMeshBadge(); });

function applyScenario(id: ScenarioId) {
  scenario = id;
  const sc = CONFIG.scenarios[id];
  spawnPerMin = sc.spawnPerMin;
  rig.applyLighting(sc.light);
  street.setNight(rig.nightFactor);
  rain.setEnabled(sc.rain);
  if (crowd) { crowd.spawnPerMin = sc.spawnPerMin; crowd.interestMul = sc.interestMul; crowd.speedMul = sc.speedMul; crowd.buyMul = sc.buyMul; crowd.setRaining(sc.rain); }
  console.info(`[sim] scenario: ${sc.label}`);
  return sc.spawnPerMin;
}

function build() {
  if (crowd) { rig.scene.remove(crowd.group); crowd.dispose(); }
  const rng = new RNG(seed);
  crowd = new Crowd(rng, storefront, bus);
  const sc = CONFIG.scenarios[scenario];
  crowd.spawnPerMin = spawnPerMin; crowd.interestMul = sc.interestMul; crowd.speedMul = sc.speedMul; crowd.buyMul = sc.buyMul; crowd.setRaining(sc.rain);
  crowd.setRaysVisible(debug.rays);
  detector = new GroundTruthDetector(cam, storefront, bus);
  crowd.onRemoved = (p) => detector.onPedestrianRemoved(simTime, p);
  rig.scene.add(crowd.group);
  metrics.reset(); alerts.reset();
  simTime = 0;
  console.info(`[sim] reset, seed=${seed}`);
}

// Saved orbit poses per view
const pose = { pos: rig.camera.position.clone(), target: rig.controls.target.clone() };
function setView(v: ViewMode) {
  if (view === 'external') { pose.pos.copy(rig.camera.position); pose.target.copy(rig.controls.target); }
  view = v;
  rig.controls.enabled = v === 'external';
  if (v === 'external') { rig.camera.position.copy(pose.pos); rig.controls.target.copy(pose.target); rig.controls.update(); }
  cam.helper.visible = debug.frustum && v !== 'camera';
  storefront.setZoneVisible(debug.zone);
  pipLabel.style.display = debug.pip && v === 'external' ? 'block' : 'none';
}

const panel = new Panel({
  onKnobs: (k) => { storefront.applyKnobs(k); return storefront.attractiveness; },
  onScenario: (id) => applyScenario(id),
  onView: (v) => setView(v),
  onPause: () => (paused = !paused),
  onReset: (s) => { seed = s; build(); },
  onSpeed: (v) => (speed = v),
  onSpawn: (v) => { spawnPerMin = v; if (crowd) crowd.spawnPerMin = v; },
  onDebug: (f) => { debug = f; crowd?.setRaysVisible(f.rays); setView(view); },
});
applyScenario('regular');
panel.setSpawn(spawnPerMin);
build();
setView('external');

// Campaigns only ever arrive from the agents (after owner approval). Nothing here is editable by hand.
mesh.on('display.set', (e) => {
  if (e.payload.expiresAt < Date.now()) return;
  const c = e.payload.campaign;
  storefront.applyCampaign({ active: true, headline: c.headline, subline: c.subline, color: c.color, poster: true, banner: false, aFrame: true });
  storefront.setScreenImage(`${HTTP_BASE}${c.imageUrl ?? c.posterUrl}`);
  panel.setLiveCampaign(`${c.kind.toUpperCase()} · ${c.headline} — ${c.subline} · code ${c.code} · ${c.items.join(', ')} · image via ${c.imageProvider}`, storefront.attractiveness);
});
mesh.on('display.clear', () => { storefront.applyCampaign({ ...storefront.campaign, active: false }); storefront.setScreenImage(null); panel.setLiveCampaign(null, storefront.attractiveness); });
mesh.on('sim.control', (e) => {
  if (e.payload.action === 'scenario') panel.selectScenario(e.payload.scenario as ScenarioId);
  else if (e.payload.action === 'reset') { build(); }
});

// Fixed-step simulation loop with a rendering pass
const DT = CONFIG.sim.fixedDt;
let acc = 0, last = performance.now(), lastStats = -1;
function frame(now: number) {
  requestAnimationFrame(frame);
  const real = Math.min(0.25, (now - last) / 1000); last = now;
  if (!paused) {
    acc += real * speed;
    let steps = 0;
    while (acc >= DT && steps < CONFIG.sim.maxSubSteps) {
      crowd.update(DT, simTime);
      simTime += DT;
      detector.update(simTime, DT, crowd.peds);
      acc -= DT; steps++;
    }
    if (steps === CONFIG.sim.maxSubSteps) acc = 0;
    rain.update(real * Math.min(speed, 2));
    if (simTime - foot.lastT >= 5 || simTime < foot.lastT) { if (simTime < foot.lastT) foot.lastT = 0; flushFootfall(); }
  }
  if (simTime - lastStats >= 0.5) {
    lastStats = simTime;
    const s = metrics.compute(simTime);
    panel.render(s, crowd.peds.filter((p) => p.nearSide && !p.isInside).length, detector.lookingCount, crowd.insideCount);
    for (const a of alerts.evaluate(s)) { panel.pushAlert(a); console.warn('[alert]', a.kind, a.message); }
  }

  rig.controls.update();
  const r = rig.renderer;
  const w = container.clientWidth, h = container.clientHeight;
  r.setViewport(0, 0, w, h); r.setScissorTest(false);
  if (view === 'camera') {
    cam.viewCamera.aspect = w / h; cam.viewCamera.updateProjectionMatrix();
    r.render(rig.scene, cam.viewCamera);
  } else {
    r.render(rig.scene, rig.camera);
    if (view === 'external' && debug.pip) {
      const pw = Math.floor(Math.min(360, w * 0.28)), ph = Math.floor(pw * 9 / 16);
      cam.viewCamera.aspect = 16 / 9; cam.viewCamera.updateProjectionMatrix();
      r.setViewport(12, 36, pw, ph); r.setScissor(12, 36, pw, ph); r.setScissorTest(true);
      r.clearDepth();
      r.render(rig.scene, cam.viewCamera);
      r.setScissorTest(false);
    }
  }
}
requestAnimationFrame(frame);

// Expose for console poking
(window as unknown as { sim: unknown }).sim = {
  get crowd() { return crowd; }, get simTime() { return simTime; }, get view() { return view; }, get scenario() { return scenario; },
  storefront, cam, metrics, rig, setView, applyScenario, THREE,
};
