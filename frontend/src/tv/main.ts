import { MeshClient } from '../mesh/meshClient';
import type { Promo } from '../../../shared/mesh-types';

const $ = (id: string) => document.getElementById(id)!;
const MENU: [string, string][] = [['Flat white', '$5.50'], ['Cortado', '$4.75'], ['Avocado toast', '$12'], ['Small plates', '$14'], ['Glass of wine', '$13'], ['Pastry', '$4.25'], ['Soup of the day', '$9'], ['Cold brew', '$5']];
$('menu').innerHTML = MENU.map(([n, p]) => `<div><span>${n}</span><span>${p}</span></div>`).join('');
setInterval(() => { const d = new Date(); $('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);

const THEME: Record<Promo['color'], { bg: string; fg: string }> = {
  red: { bg: 'radial-gradient(1200px 800px at 30% 20%, #e4553f, #8e2419)', fg: '#fff6ee' },
  teal: { bg: 'radial-gradient(1200px 800px at 30% 20%, #1aa3a8, #0b4d52)', fg: '#f2fbfb' },
  gold: { bg: 'radial-gradient(1200px 800px at 30% 20%, #f7cf5a, #b8860b)', fg: '#2b1d0e' },
  black: { bg: 'radial-gradient(1200px 800px at 30% 20%, #2b2b2b, #0a0a0a)', fg: '#f2c14e' },
};
let expiresAt = 0, timer: number | null = null;

function showPromo(promo: Promo, exp: number) {
  expiresAt = exp;
  $('p-head').textContent = promo.headline;
  $('p-sub').textContent = promo.subline;
  $('p-code').textContent = promo.code;
  const th = THEME[promo.color] ?? THEME.red;
  $('tv').style.background = th.bg; $('tv').style.color = th.fg;
  $('idle').style.display = 'none'; $('promo').classList.add('on');
  if (timer) clearInterval(timer);
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $('p-count').textContent = `${m}:${s.toString().padStart(2, '0')}`;
    if (left <= 0) clearPromo();
  };
  tick(); timer = window.setInterval(tick, 500);
}
function clearPromo() {
  if (timer) clearInterval(timer); timer = null;
  $('promo').classList.remove('on'); $('idle').style.display = '';
  $('tv').style.background = ''; $('tv').style.color = '';
}

const mesh = new MeshClient('tv');
mesh.onConnection = (c) => { $('s-conn').textContent = c ? 'connected' : 'reconnecting…'; };
mesh.on('display.set', (e) => { if (e.payload.expiresAt > Date.now()) showPromo(e.payload.promo, e.payload.expiresAt); });
mesh.on('display.clear', () => clearPromo());
mesh.on('mesh.status', (e) => { $('s-prov').textContent = e.payload.provider + (e.payload.online ? '' : ' (offline)'); });
