import { Alert } from './alerts';
import { Stats } from './metrics';
import { Campaign, CampaignColor, StorefrontKnobs } from '../world/storefront';
import { ScenarioId } from '../config';

export type ViewMode = 'external' | 'camera';
export interface DebugFlags { rays: boolean; frustum: boolean; zone: boolean; pip: boolean }

export interface PanelCallbacks {
  onKnobs(k: StorefrontKnobs): number;      // returns resulting attractiveness
  onCampaign(c: Campaign): number;          // returns resulting attractiveness
  onScenario(id: ScenarioId): number;       // returns the scenario's spawn rate (to sync the slider)
  onView(v: ViewMode): void;
  onPause(): boolean;                       // returns new paused state
  onReset(seed: number): void;
  onSpeed(v: number): void;
  onSpawn(v: number): void;
  onDebug(flags: DebugFlags): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const inp = (id: string) => $<HTMLInputElement>(id);

/** HUD + right-hand drawer: live stats, heatmap, alert feed, campaign, knobs, controls. */
export class Panel {
  private heatCells: HTMLDivElement[] = [];
  private alertsEl = $('alerts');

  constructor(cb: PanelCallbacks) {
    const heat = $('heat');
    for (let i = 0; i < 16; i++) { const d = document.createElement('div'); heat.appendChild(d); this.heatCells.push(d); }

    // segmented controls
    const seg = (containerId: string, attr: string, fn: (v: string) => void) => {
      const c = $(containerId);
      c.querySelectorAll<HTMLButtonElement>(`button[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
        c.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        fn(b.dataset[attr]!);
      }));
    };
    seg('views', 'view', (v) => cb.onView(v as ViewMode));
    seg('scenarios', 'scenario', (v) => { const spawn = cb.onScenario(v as ScenarioId); inp('c-spawn').value = String(spawn); $('c-spawn-v').textContent = String(spawn); });

    $('c-panel').addEventListener('click', () => { $('panel').classList.toggle('hidden'); $('c-panel').classList.toggle('on'); });

    const knobs = () => this.setAttractiveness(cb.onKnobs(this.readKnobs()));
    for (const id of ['k-sign', 'k-awning', 'k-window', 'k-aframe']) $(id).addEventListener('input', knobs);
    knobs();

    const camp = () => { const c = this.readCampaign(); $('camp').classList.toggle('live', c.active); this.setAttractiveness(cb.onCampaign(c)); };
    for (const id of ['m-active', 'm-head', 'm-sub', 'm-color', 'm-aframe']) $(id).addEventListener('input', camp);
    camp();

    $('c-pause').addEventListener('click', () => { $('c-pause').textContent = cb.onPause() ? 'Resume' : 'Pause'; });
    $('c-reset').addEventListener('click', () => { cb.onReset(Number(inp('c-seed').value) || 1); this.alertsEl.innerHTML = ''; });
    const speed = inp('c-speed'), spawn = inp('c-spawn');
    speed.addEventListener('input', () => { $('c-speed-v').textContent = `${speed.value}×`; cb.onSpeed(Number(speed.value)); });
    spawn.addEventListener('input', () => { $('c-spawn-v').textContent = spawn.value; cb.onSpawn(Number(spawn.value)); });
    $('c-speed-v').textContent = `${speed.value}×`; $('c-spawn-v').textContent = spawn.value;
    cb.onSpeed(Number(speed.value));

    const dbg = () => cb.onDebug({ rays: inp('d-rays').checked, frustum: inp('d-frustum').checked, zone: inp('d-zone').checked, pip: inp('d-pip').checked });
    for (const id of ['d-rays', 'd-frustum', 'd-zone', 'd-pip']) $(id).addEventListener('input', dbg);
    dbg();
  }

  readKnobs(): StorefrontKnobs {
    const sign = Number(inp('k-sign').value);
    $('k-sign-v').textContent = sign.toFixed(2);
    return { signBrightness: sign, awning: inp('k-awning').checked, windowDisplay: inp('k-window').checked, aFrame: inp('k-aframe').checked };
  }

  readCampaign(): Campaign {
    return {
      active: inp('m-active').checked, headline: inp('m-head').value, subline: inp('m-sub').value,
      color: $<HTMLSelectElement>('m-color').value as CampaignColor,
      poster: true, banner: false, aFrame: inp('m-aframe').checked,
    };
  }

  /** Programmatic campaign update (from the mesh); fires the same handlers as typing. */
  setCampaign(c: Campaign) {
    inp('m-active').checked = c.active; inp('m-head').value = c.headline; inp('m-sub').value = c.subline;
    $<HTMLSelectElement>('m-color').value = c.color; inp('m-aframe').checked = c.aFrame;
    $('m-active').dispatchEvent(new Event('input'));
  }
  selectScenario(id: ScenarioId) { $('scenarios').querySelector<HTMLButtonElement>(`button[data-scenario="${id}"]`)?.click(); }

  setAttractiveness(a: number) { $('k-attr').textContent = `attractiveness ${a.toFixed(2)}`; }
  setSpawn(v: number) { inp('c-spawn').value = String(v); $('c-spawn-v').textContent = String(v); }

  render(s: Stats, onSidewalk: number, lookingNow: number, insideNow: number) {
    $('s-pass').textContent = s.passersbyPerMin.toFixed(0);
    $('s-look').textContent = `${(s.lookRate * 100).toFixed(0)}%`;
    $('s-dwell').textContent = `${s.avgDwellSec.toFixed(1)}s`;
    $('s-enter').textContent = String(s.entries);
    $('s-buy').textContent = String(s.purchases);
    $('s-inside').textContent = `${s.avgInsideSec.toFixed(0)}s`;
    $('s-live').textContent = `${onSidewalk} on sidewalk · ${lookingNow} looking now · ${insideNow} inside · ${s.stops} stops/min`;
    $('t-look').textContent = `${(s.lookRate * 100).toFixed(0)}%`;
    $('t-inside').textContent = String(insideNow);
    const mm = Math.floor(s.t / 60), ss = Math.floor(s.t % 60);
    $('t-clock').textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    const max = Math.max(1, ...s.heat);
    s.heat.forEach((v, i) => {
      const f = v / max;
      this.heatCells[i].style.background = `rgba(79,194,122,${0.08 + f * 0.9})`;
      this.heatCells[i].title = `${v} gaze starts`;
    });
  }

  pushAlert(a: Alert) {
    const el = document.createElement('div');
    el.className = `alert ${a.severity}`;
    const mm = Math.floor(a.t / 60), ss = Math.floor(a.t % 60);
    el.innerHTML = `<div class="t">${a.kind} · t=${mm}:${ss.toString().padStart(2, '0')}</div><div class="m">${a.message}</div>`;
    this.alertsEl.prepend(el);
    while (this.alertsEl.children.length > 30) this.alertsEl.lastChild?.remove();
  }
}
