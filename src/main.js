import * as THREE from 'three';
import { Stage } from './stage.js';
import { Vinyl, Sleeve, Insert, SLEEVE, INSERT, VINYL } from './objects.js';
import { makeGrooveMaps, makeMarble, makeSplatter, makeSplit, discTextureFromImage, borderColor } from './textures.js';
import { renderLoop, beginMotion, applyMotion, endMotion, MOTIONS } from './video.js';
import { listProjects, getProject, putProject, deleteProject, newId, exportBackup, importBackup } from './collection.js';

const $ = (id) => document.getElementById(id);
const PI = Math.PI;

// ---------------------------------------------------------------- state
const state = {
  layout: 'stack',
  frame: '4:5',
  slide: 0.45,
  side: 'A',
  vinyl: 'artwork',
  vinylColors: {},
  finish: 'matte',
  edge: '#f2f0ec',
  bg: '#d8cec7',
  bgMode: 'color', // 'color' | 'transparent' | 'media'
  imgSize: 3000,
  vid: { motion: 'spin', duration: 6, turns: 1, fps: 30 }, // format = state.frame
  exposure: 1,
  lift: 0,
  varnish: true,
  glint: 0.6,
  wear: 0.4,
  warp: 0.25,
  dust: 0.3,
};
let wearT;
let bgMedia = null; // { el, w, h, name } photo or video backdrop

// ---------------------------------------------------------------- scene objects
const stage = new Stage($('c'));
const grooves = makeGrooveMaps();
const cardOpts = { maxAniso: stage.renderer.capabilities.getMaxAnisotropy() };
const vinyl = new Vinyl(grooves);
const sleeve = new Sleeve(cardOpts);
const sleeve2 = sleeve.clone();
const insert = new Insert(cardOpts);
const insert2 = insert.clone();
const objects = { vinyl: vinyl.group, sleeve: sleeve.mesh, sleeve2, insert: insert.mesh, insert2 };
Object.values(objects).forEach((o) => stage.root.add(o));

// ---------------------------------------------------------------- layouts
const S = SLEEVE.t, W = SLEEVE.w, I = INSERT.t, VH = VINYL.half, VR = VINYL.r;
const flatFront = (ry = 0) => new THREE.Euler(-PI / 2, ry, 0, 'YXZ');
const flatBack = (ry = 0) => new THREE.Euler(PI / 2, ry, PI, 'YXZ');
const flat = (ry = 0) => new THREE.Euler(0, ry, 0, 'YXZ');
const upright = (ry = 0) => new THREE.Euler(0, ry, 0, 'YXZ');
const uprightDisc = (ry = 0) => new THREE.Euler(PI / 2, ry, 0, 'YXZ');

const icon = (body) => `<svg viewBox="0 0 46 34" fill="none" stroke="currentColor" stroke-width="1.3">${body}</svg>`;
const LAYOUTS = {
  stack: {
    name: 'Flat stack',
    icon: icon('<rect x="3" y="10" width="18" height="18" rx="1"/><rect x="11" y="5" width="18" height="18" rx="1" fill="var(--panel-2)"/><circle cx="33" cy="12" r="9" fill="var(--panel-2)"/><circle cx="33" cy="12" r="2.5"/>'),
    items: (s) => [
      ['sleeve2', [-9.5, S / 2, 7.5], flatBack(0.05)],
      // each board's corners curl up by `warp`: rest the next item on top of them
      ['sleeve', [0, S * 1.5 + s.warp, 0], flatFront(-0.03)],
      ['vinyl', [14, S * 2 + VH + s.warp * 2, -7.5], flat(0)],
    ],
    cam: { az: -20, el: 50, lens: 70, zoom: 1 },
  },
  sleeveOut: {
    name: 'Sleeve + vinyl',
    icon: icon('<circle cx="27" cy="17" r="12"/><circle cx="27" cy="17" r="3"/><rect x="5" y="4" width="26" height="26" rx="1" fill="var(--panel-2)"/>'),
    items: (s) => [
      ['sleeve', [0, S / 2, 0], flatFront(0)],
      ['vinyl', [s.slide * W, S / 2, 0], flat(0)],
    ],
    cam: { az: -14, el: 44, lens: 70, zoom: 1 },
    slide: true,
  },
  standing: {
    name: 'Standing',
    icon: icon('<path d="M3 31h40" stroke-opacity=".4"/><circle cx="28" cy="18" r="12"/><rect x="6" y="5" width="24" height="26" fill="var(--panel-2)"/>'),
    items: (s) => [
      ['sleeve', [0, W / 2, 0], upright(0)],
      ['vinyl', [s.slide * W, VR + 0.3, 0], uprightDisc(0)],
    ],
    cam: { az: -24, el: 10, lens: 85, zoom: 1 },
    light: { az: 320, el: 34 },
    slide: true,
    upright: true, // 360 = turntable; flat lays flip over instead
  },
  bundle: {
    name: 'Full bundle',
    icon: icon('<rect x="2" y="9" width="17" height="17" transform="rotate(-10 10 17)"/><circle cx="31" cy="17" r="11"/><rect x="9" y="5" width="22" height="22" rx="1" fill="var(--panel-2)"/>'),
    items: (s) => [
      ['insert', [-12, I / 2, 6], flatFront(0.22)],
      ['sleeve', [0, I + s.warp * 0.4 + S / 2, 0], flatFront(-0.02)],
      ['vinyl', [s.slide * W, I + s.warp * 0.4 + S / 2, 0], flat(0)],
    ],
    cam: { az: -18, el: 48, lens: 70, zoom: 1 },
    slide: true,
  },
  vinyl: {
    name: 'Vinyl only',
    icon: icon('<circle cx="23" cy="17" r="13"/><circle cx="23" cy="17" r="4"/><circle cx="23" cy="17" r="9" stroke-opacity=".35"/>'),
    items: () => [['vinyl', [0, VH, 0], flat(0)]],
    cam: { az: -10, el: 42, lens: 70, zoom: 1 },
  },
  vinylStand: {
    name: 'Vinyl hero',
    icon: icon('<path d="M3 31h40" stroke-opacity=".4"/><ellipse cx="23" cy="17" rx="10" ry="13"/><ellipse cx="23" cy="17" rx="3" ry="4"/>'),
    items: () => [['vinyl', [0, VR + 0.3, 0], uprightDisc(0)]],
    cam: { az: -22, el: 8, lens: 85, zoom: 1 },
    light: { az: 320, el: 34 },
    upright: true,
  },
  front: {
    name: 'Front cover',
    icon: icon('<rect x="9" y="3" width="28" height="28" rx="1"/><path d="M14 22l6-7 5 5 4-3 5 5" stroke-opacity=".6"/>'),
    items: () => [['sleeve', [0, S / 2, 0], flatFront(0)]],
    cam: { az: -12, el: 56, lens: 70, zoom: 1 },
  },
  back: {
    name: 'Back cover',
    icon: icon('<rect x="9" y="3" width="28" height="28" rx="1"/><path d="M14 10h18M14 15h12M14 20h15M14 25h9" stroke-opacity=".6"/>'),
    items: () => [['sleeve', [0, S / 2, 0], flatBack(0)]],
    cam: { az: -12, el: 56, lens: 70, zoom: 1 },
  },
  frontBack: {
    name: 'Front + back',
    icon: icon('<rect x="2" y="8" width="20" height="20" rx="1"/><rect x="24" y="8" width="20" height="20" rx="1"/><path d="M28 14h12M28 18h8M28 22h10" stroke-opacity=".6"/>'),
    items: () => [
      ['sleeve', [-17.2, S / 2, 0], flatFront(0.03)],
      ['sleeve2', [17.2, S / 2, 0], flatBack(-0.03)],
    ],
    cam: { az: -8, el: 50, lens: 70, zoom: 1 },
  },
  insert: {
    name: 'Insert',
    icon: icon('<rect x="2" y="8" width="20" height="20"/><rect x="24" y="8" width="20" height="20"/><path d="M2 20c6-3 12-3 20 0M24 20c6-3 12-3 20 0" stroke-opacity=".6"/>'),
    items: () => [
      ['insert', [-16, I / 2, 0], flatFront(0.02)],
      ['insert2', [16, I / 2, 0], flatBack(-0.02)],
    ],
    cam: { az: -8, el: 52, lens: 70, zoom: 1 },
  },
};

// reframe: true = the layout's preset camera, 'fit' = keep the current angles/lens/zoom but refit the new bounds
// (sliders that move things, so nothing slides out of shot), false = leave the camera alone
function applyLayout({ reframe = true } = {}) {
  stopPreview(); // a running loop animates the pivot/camera this rebuilds
  const L = LAYOUTS[state.layout];
  Object.values(objects).forEach((o) => (o.visible = false));
  for (const [key, pos, rot] of L.items(state)) {
    const o = objects[key];
    o.visible = true;
    o.position.set(...pos);
    o.rotation.copy(rot);
    o.userData.clipsVinyl = !!L.slide && key === 'sleeve';
    if (key !== 'vinyl') (key.startsWith('sleeve') ? sleeve : insert).orient(o, rot.x > 0.1 ? 'back' : 'front');
  }
  vinyl.setSide(state.side);
  vinyl.setClip(L.slide ? sleeveClip : null);
  // from the scene root: the pivot (stage.turn) may have moved since the last render, and a stale parent matrix
  // would shift every measured point (-> off-centre framing while dragging a slider or switching scenes quickly)
  stage.scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const pts = [];
  stage.root.children.forEach((o) => {
    if (!o.visible) return;
    box.expandByObject(o, true); // exact: a spun record's rotated bounding box would be ~20% too big
    o.traverse((m) => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 400));
      for (let i = 0; i < pos.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    });
  });
  stage.setBounds(box, pts);
  $('slideRow').style.display = L.slide ? '' : 'none';
  if (reframe === 'fit') {
    stage.frame({});
    refreshCam();
  } else if (reframe) {
    stage.frame({ ...L.cam });
    // upright scenes need a front key; flat lays look best back-lit (long shadows toward camera)
    const wantFront = !!L.light;
    if (wantFront !== (Math.cos((stage.light.az - 320) * PI / 180) > 0.7)) stage.setLight(L.light || { az: 245, el: 32 });
    refreshLight();
  }
  stage.invalidate();
  document.querySelectorAll('.layout').forEach((b) => b.classList.toggle('on', b.dataset.v === state.layout));
}

// clipping plane at the sleeve's opening (local +x edge), kept in world space every frame
const sleeveClip = new THREE.Plane();
const localOpening = new THREE.Plane(new THREE.Vector3(1, 0, 0), -(SLEEVE.w / 2 - 0.05));
stage.renderer.localClippingEnabled = true;
stage.beforeRender = () => {
  if (!vinyl.material.clippingPlanes) return;
  stage.scene.updateMatrixWorld();
  sleeveClip.copy(localOpening).applyMatrix4(sleeve.mesh.matrixWorld);
};

// ---------------------------------------------------------------- artwork
const SLOTS = {
  coverFront: { name: 'Cover front', url: '/assets/cover-front.png' },
  coverBack: { name: 'Cover back', url: '/assets/cover-back.png' },
  labelA: { name: 'Label side A', url: '/assets/label-a.png', round: true },
  labelB: { name: 'Label side B', url: '/assets/label-b.png', round: true },
  vinylArt: { name: 'Vinyl artwork', url: '/assets/vinyl-marble.png', round: true },
  // `more`: tucked under "Insert & varnish"
  insertRecto: { name: 'Insert recto', url: '/assets/insert-recto.jpg', more: true },
  insertVerso: { name: 'Insert verso', url: '/assets/insert-verso.jpg', more: true },
  varnishFront: { name: 'Varnish front', url: '/assets/varnish-front.png', varnish: true, more: true },
  varnishBack: { name: 'Varnish back', url: '/assets/varnish-back.png', varnish: true, more: true },
};
const images = {};
const maxAniso = stage.renderer.capabilities.getMaxAnisotropy();

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
function tex(img) {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.needsUpdate = true;
  return t;
}

let vinylArtTex = null;
function applySlot(key) {
  const img = images[key];
  switch (key) {
    case 'coverFront':
      sleeve.setArt('front', img);
      state.edge = borderColor(img);
      $('edgeColor').value = state.edge;
      sleeve.setEdge(state.edge);
      break;
    case 'coverBack': sleeve.setArt('back', img); break;
    case 'varnishFront': sleeve.setVarnishMask('front', img); refreshVarnishUI(); break;
    case 'varnishBack': sleeve.setVarnishMask('back', img); refreshVarnishUI(); break;
    case 'insertRecto': insert.setArt('front', img); break;
    case 'insertVerso': insert.setArt('back', img); break;
    case 'labelA':
    case 'labelB':
      vinyl.labelA.material.map?.dispose(); vinyl.labelB.material.map?.dispose();
      vinyl.setLabels(images.labelA && tex(images.labelA), images.labelB && tex(images.labelB));
      break;
    case 'vinylArt':
      vinylArtTex?.dispose();
      vinylArtTex = discTextureFromImage(img);
      if (state.vinyl === 'artwork') applyVinyl();
      break;
  }
  stage.invalidate();
  const el = document.querySelector(`.slot[data-k="${key}"] .thumb`);
  if (el) el.style.backgroundImage = `url("${img.src}")`;
  renderSwatches();
}

function buildSlots() {
  for (const [k, s] of Object.entries(SLOTS)) {
    const wrap = $(s.more ? 'slotsMore' : 'slots');
    const b = document.createElement('div');
    b.className = 'slot';
    b.dataset.k = k;
    b.innerHTML = `<div class="thumb ${s.round ? 'round' : ''} ${s.varnish ? 'varnish' : ''}"></div><span>${s.name}</span>`
      + (s.varnish ? '<button class="slot-clear" title="Remove">×</button>' : '');
    const clr = b.querySelector('.slot-clear');
    if (clr) clr.onclick = (e) => { e.stopPropagation(); clearSlot(k); };
    b.onclick = () => pickFile(k);
    b.ondragover = (e) => { e.preventDefault(); b.classList.add('drag'); };
    b.ondragleave = () => b.classList.remove('drag');
    b.ondrop = (e) => {
      e.preventDefault(); b.classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f) setSlotFile(k, f);
    };
    wrap.appendChild(b);
  }
}
// swaps the image behind a slot, releasing the blob: URL of the one it replaces
function setImage(k, img) {
  const old = images[k]?.src;
  if (old?.startsWith('blob:') && old !== img?.src) URL.revokeObjectURL(old);
  if (img) images[k] = img; else delete images[k];
}
function clearSlot(k) {
  setImage(k, null);
  const side = k === 'varnishFront' ? 'front' : 'back';
  sleeve.setVarnishMask(side, null);
  document.querySelector(`.slot[data-k="${k}"] .thumb`).style.backgroundImage = '';
  refreshVarnishUI();
  stage.invalidate();
  refreshDirty();
}
function refreshVarnishUI() {
  const has = !!(images.varnishFront || images.varnishBack);
  $('varnishRows').style.display = has ? '' : 'none';
  $('varnishNone').style.display = has ? 'none' : '';
  stage.setGlint(has && state.varnish ? state.glint : 0);
}
let pickKey = null;
function pickFile(k) { pickKey = k; $('filePick').value = ''; $('filePick').click(); }
$('filePick').onchange = (e) => { const f = e.target.files[0]; if (f && pickKey) setSlotFile(pickKey, f); };
async function setSlotFile(k, file) {
  setImage(k, await loadImage(URL.createObjectURL(file)));
  applySlot(k);
  refreshDirty();
}

// ---------------------------------------------------------------- vinyl finishes
const VINYLS = {
  artwork: { name: 'Artwork', mode: 'texture' },
  black: { name: 'Black', mode: 'solid', colors: ['#0b0b0b'] },
  white: { name: 'White', mode: 'solid', colors: ['#eeebe5'] },
  clear: { name: 'Clear', mode: 'clear', colors: ['#ffffff'] },
  smoke: { name: 'Smoke', mode: 'clear', colors: ['#5d5b58'] },
  marble: { name: 'Marble', mode: 'marble', colors: ['#eeebe5', '#1d1c1b', '#b8b2a8'] },
  color: { name: 'Color', mode: 'solid', colors: ['#c8321e'] },
  tinted: { name: 'Tinted', mode: 'clear', colors: ['#ff7a2a'] },
  splatter: { name: 'Splatter', mode: 'splatter', colors: ['#eeebe5', '#151515', '#ff5a1f'] },
  split: { name: 'Split', mode: 'split', colors: ['#111111', '#eeebe5'] },
};
const seeds = { marble: 3, splatter: 5 };
let splitAngle = 90;
for (const [k, v] of Object.entries(VINYLS)) state.vinylColors[k] = [...(v.colors || [])];

function swatchBg(k) {
  const c = state.vinylColors[k];
  switch (k) {
    case 'artwork': return images.vinylArt ? `url("${images.vinylArt.src}")` : '#888';
    case 'clear': return `radial-gradient(circle at 35% 30%, rgba(255,255,255,.7), rgba(255,255,255,.12) 45%, rgba(255,255,255,.3))`;
    case 'smoke': case 'tinted': return `radial-gradient(circle at 35% 30%, ${c[0]}cc, ${c[0]}66 60%)`;
    case 'marble': return `conic-gradient(from 20deg, ${c[0]}, ${c[2]}, ${c[0]} 30%, ${c[1]} 33%, ${c[0]} 38%, ${c[2]} 60%, ${c[0]} 70%, ${c[1]} 72%, ${c[0]})`;
    case 'splatter': return `radial-gradient(circle at 30% 30%, ${c[1]} 3px, transparent 4px), radial-gradient(circle at 70% 60%, ${c[2]} 4px, transparent 5px), radial-gradient(circle at 60% 20%, ${c[2]} 2px, transparent 3px), radial-gradient(circle at 25% 75%, ${c[1]} 2px, transparent 3px), ${c[0]}`;
    case 'split': return `linear-gradient(90deg, ${c[0]} 50%, ${c[1]} 50%)`;
    default: return c[0];
  }
}
function renderSwatches() {
  const wrap = $('swatches');
  wrap.innerHTML = '';
  for (const [k, v] of Object.entries(VINYLS)) {
    const b = document.createElement('button');
    b.className = 'swatch' + (state.vinyl === k ? ' on' : '');
    b.innerHTML = `<i style='background:${swatchBg(k)};background-size:cover;background-position:center'></i>${v.name}`;
    b.onclick = () => { state.vinyl = k; applyVinyl(); renderSwatches(); renderVinylOpts(); };
    wrap.appendChild(b);
  }
}

let vinylTexCache = {};
function applyVinyl() {
  const k = state.vinyl, v = VINYLS[k], c = state.vinylColors[k];
  let map = null;
  if (v.mode === 'texture') map = vinylArtTex;
  if (v.mode === 'marble' || v.mode === 'splatter' || v.mode === 'split') {
    const key = `${k}|${c.join()}|${seeds[k] ?? ''}|${splitAngle}`;
    if (!vinylTexCache[key]) {
      const opts = { c1: c[0], c2: c[1], c3: c[2], seed: seeds[k], angle: splitAngle };
      vinylTexCache[key] = v.mode === 'marble' ? makeMarble(opts) : v.mode === 'splatter' ? makeSplatter(opts) : makeSplit(opts);
    }
    map = vinylTexCache[key];
  }
  vinyl.setStyle({
    mode: v.mode === 'clear' ? 'clear' : map ? 'texture' : 'solid',
    color: c[0], tint: c[0], map,
  });
  stage.invalidate();
}

function renderVinylOpts() {
  const k = state.vinyl, v = VINYLS[k], wrap = $('vinylOpts');
  wrap.innerHTML = '';
  if (v.mode === 'texture') {
    wrap.innerHTML = `<p class="hint">Uses the <b>Vinyl artwork</b> slot — a top-down PNG of the disc (transparent background). Grooves &amp; sheen are added on top.</p>`;
    return;
  }
  const labels = { solid: ['Color'], clear: ['Tint'], marble: ['Base', 'Veins', 'Clouds'], splatter: ['Base', 'Splat 1', 'Splat 2'], split: ['Left', 'Right'] }[v.mode];
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>Colors</label><div class="colors"></div>`;
  labels.forEach((lab, i) => {
    const inp = document.createElement('input');
    inp.type = 'color'; inp.title = lab; inp.value = state.vinylColors[k][i];
    let t;
    inp.oninput = () => {
      state.vinylColors[k][i] = inp.value;
      clearTimeout(t);
      t = setTimeout(() => { applyVinyl(); renderSwatches(); }, v.mode === 'solid' || v.mode === 'clear' ? 0 : 120);
    };
    row.querySelector('.colors').appendChild(inp);
  });
  wrap.appendChild(row);
  if (seeds[k] !== undefined) {
    const b = document.createElement('button');
    b.className = 'ghost'; b.textContent = '↻ Shuffle pattern';
    b.onclick = () => { seeds[k] = Math.floor(Math.random() * 1000) + 1; applyVinyl(); };
    wrap.appendChild(b);
  }
  if (v.mode === 'split') {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<label>Split angle</label><input type="range" min="0" max="180" step="1" value="${splitAngle}"><output>${splitAngle}°</output>`;
    const inp = r.querySelector('input');
    inp.oninput = () => { splitAngle = +inp.value; r.querySelector('output').textContent = splitAngle + '°'; applyVinyl(); };
    wrap.appendChild(r);
  }
}

// ---------------------------------------------------------------- generic UI helpers
const refreshers = []; // every seg/slider (studio ones included), re-synced from state when a saved vinyl is opened
function seg(id, get, set) {
  const el = $(id);
  const refresh = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  el.querySelectorAll('button').forEach((b) => (b.onclick = () => { set(b.dataset.v); refresh(); }));
  refresh();
  refreshers.push(refresh);
  return refresh;
}
function slider(id, get, set, fmt = (v) => v) {
  const el = $(id), out = $(id + 'Out');
  const refresh = () => { el.value = get(); if (out) out.textContent = fmt(+el.value); };
  el.oninput = () => { set(+el.value); if (out) out.textContent = fmt(+el.value); };
  refresh();
  refreshers.push(refresh);
  return refresh;
}

// ---------------------------------------------------------------- frame / viewport
function aspectOf(f) { const [a, b] = f.split(':').map(Number); return a / b; }
function fitViewport() {
  const wrap = $('canvasWrap');
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const a = aspectOf(state.frame);
  let w = aw, h = aw / a;
  if (h > ah) { h = ah; w = ah * a; }
  stage.setAspect(a, Math.floor(w), Math.floor(h));
}
new ResizeObserver(() => { fitViewport(); stage.frame({}, true); }).observe($('canvasWrap'));

// ---------------------------------------------------------------- build UI
function buildLayouts() {
  const wrap = $('layouts');
  for (const [k, L] of Object.entries(LAYOUTS)) {
    const b = document.createElement('button');
    b.className = 'layout'; b.dataset.v = k;
    b.innerHTML = `${L.icon}<span>${L.name}</span>`;
    b.onclick = () => { state.layout = k; applyLayout(); refreshCam(); };
    wrap.appendChild(b);
  }
}

const CAM_PRESETS = {
  'Hero': null,
  'Top down': { az: 0, el: 89.5 },
  '3/4': { az: -28, el: 42 },
  'Low': { az: -30, el: 14 },
  'Side': { az: -72, el: 26 },
};
const LIGHT_PRESETS = {
  'Soft studio': { az: 225, el: 55, softness: 0.8, strength: 0.32, ambient: 0.6, contact: 0.35, falloff: 0.55, warmth: 0.52 },
  'Window': { az: 245, el: 32, softness: 0.3, strength: 0.45, ambient: 0.5, contact: 0.3, falloff: 0.45, warmth: 0.6 },
  'Top light': { az: 200, el: 80, softness: 0.6, strength: 0.4, ambient: 0.65, contact: 0.4, falloff: 0.6, warmth: 0.5 },
  'Hard sun': { az: 250, el: 38, softness: 0.03, strength: 0.55, ambient: 0.35, contact: 0.25, falloff: 0, warmth: 0.68 },
};
// Photo looks: 'Photo' is the stage's default look
const PHOTO_PRESETS = {
  'Clean': { fstop: 0, grain: 0, vignette: 0, bloom: 0, ca: 0, look: 0 },
  'Photo': { fstop: 5.6, grain: 0.35, vignette: 0.2, bloom: 0.35, ca: 0.3, look: 0.5 },
  'Shallow': { fstop: 1.4, grain: 0.3, vignette: 0.3, bloom: 0.45, ca: 0.35, look: 0.5 },
  'Film': { fstop: 2.8, grain: 0.7, vignette: 0.45, bloom: 0.6, ca: 0.5, look: 0.9 },
};
// sleeve wear / warp + vinyl dust together; 'Used' is the default
const CONDITIONS = {
  mint: { name: 'Mint', wear: 0.05, warp: 0.05, dust: 0.05 },
  used: { name: 'Used', wear: 0.4, warp: 0.25, dust: 0.3 },
  vintage: { name: 'Vintage', wear: 0.85, warp: 0.7, dust: 0.75 },
};
const BGS = ['#d8cec7', '#f3f0eb', '#bdb8b1', '#c9cfc2', '#2b2a29', '#111111'];

let refreshCam = () => {};
// highlight the preset that matches the current settings (none once a slider has moved away from it)
const presetRefreshers = [];
const refreshPresets = () => presetRefreshers.forEach((f) => f());
const matches = (cur, p) => Object.entries(p).every(([k, v]) => typeof v !== 'number' || Math.abs(cur[k] - v) < 1e-3);
function presetChips(id, presets, apply, current) {
  const btns = Object.entries(presets).map(([name, p]) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { apply(p); refreshPresets(); };
    $(id).appendChild(b);
    return [b, p];
  });
  presetRefreshers.push(() => btns.forEach(([b, p]) => b.classList.toggle('on', matches(current(), p))));
}
function applyCondition() {
  sleeve.setWear(state.wear); insert.setWear(state.wear * 0.5);
  sleeve.setWarp(state.warp); insert.setWarp(state.warp * 0.4);
  vinyl.setDust(state.dust);
}
let refreshLight = () => {};
let refreshBg = () => {};
let refreshVidDur = () => {};

function buildControls() {
  // scene
  const refreshSlide = slider('slide', () => state.slide, (v) => { state.slide = v; applyLayout({ reframe: 'fit' }); }, (v) => Math.round(v * 100) + '%');
  seg('side', () => state.side, (v) => { state.side = v; vinyl.setSide(v); });
  seg('finish', () => state.finish, (v) => { state.finish = v; sleeve.setFinish(v); insert.setFinish(v === 'gloss' ? 'satin' : 'matte'); });
  $('edgeColor').oninput = (e) => { state.edge = e.target.value; sleeve.setEdge(state.edge); };
  seg('varnishOn', () => (state.varnish ? 'on' : 'off'), (v) => { state.varnish = v === 'on'; sleeve.setVarnish({ on: state.varnish }); refreshVarnishUI(); });
  slider('glint', () => state.glint, (x) => { state.glint = x; refreshVarnishUI(); }, (x) => Math.round(x * 100));
  seg('frame', () => state.frame, (v) => {
    const was = !!preview;
    stopPreview();
    state.frame = v; fitViewport(); stage.frame({}, true);
    updatePngHint(); refreshVidUI();
    if (was) startPreview();
  });

  // camera
  const cp = $('camPresets');
  for (const [name, p] of Object.entries(CAM_PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { stage.frame(p ? { ...p, zoom: 1 } : { ...LAYOUTS[state.layout].cam }); refreshCam(); };
    cp.appendChild(b);
  }
  const v = stage.view;
  const rc = [
    slider('az', () => v.az.toFixed(1), (x) => stage.frame({ az: x }, true), (x) => Math.round(x) + '°'),
    slider('el', () => v.el.toFixed(1), (x) => stage.frame({ el: x }, true), (x) => Math.round(x) + '°'),
    slider('lens', () => v.lens, (x) => stage.frame({ lens: x }, true), (x) => x + 'mm'),
    slider('zoom', () => v.zoom, (x) => stage.frame({ zoom: x }, true), (x) => x.toFixed(2) + '×'),
  ];
  refreshCam = () => rc.forEach((f) => f());
  let raf;
  stage.onViewChange = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(refreshCam); };

  // light
  const L = stage.light;
  presetChips('lightPresets', LIGHT_PRESETS, (p) => { stage.setLight(p); refreshLight(); }, () => L);
  const rl = [
    slider('laz', () => L.az, (x) => stage.setLight({ az: x }), (x) => x + '°'),
    slider('lel', () => L.el, (x) => stage.setLight({ el: x }), (x) => x + '°'),
    slider('soft', () => L.softness, (x) => stage.setLight({ softness: x }), (x) => Math.round(x * 100)),
    slider('master', () => L.master, (x) => stage.setLight({ master: x }), (x) => Math.round(x * 100)),
    slider('shadow', () => L.strength, (x) => stage.setLight({ strength: x }), (x) => Math.round(x * 100)),
    slider('ambient', () => L.ambient, (x) => stage.setLight({ ambient: x }), (x) => Math.round(x * 100)),
    slider('contact', () => L.contact, (x) => stage.setLight({ contact: x }), (x) => Math.round(x * 100)),
    slider('falloff', () => L.falloff, (x) => stage.setLight({ falloff: x }), (x) => Math.round(x * 100)),
    slider('bounce', () => L.bounce, (x) => stage.setLight({ bounce: x }), (x) => Math.round(x * 100)),
    slider('warmth', () => L.warmth, (x) => stage.setLight({ warmth: x }), (x) => (x > 0.5 ? '+' : '') + Math.round((x - 0.5) * 200)),
    slider('lift', () => state.lift, (x) => { state.lift = x; stage.setLift(x); applyLayout({ reframe: 'fit' }); }, (x) => x.toFixed(1) + 'cm'),
    slider('exposure', () => state.exposure, (x) => { state.exposure = x; stage.renderer.toneMappingExposure = x; }, (x) => (x > 1 ? '+' : '') + Math.round((x - 1) * 100)),
  ];
  refreshLight = () => { rl.forEach((f) => f()); refreshPresets(); };

  // photo look
  const P = stage.photo;
  presetChips('photoPresets', PHOTO_PRESETS, (p) => { stage.setPhoto(p); refreshers.forEach((f) => f()); }, () => P);
  seg('dof', () => P.fstop, (v) => stage.setPhoto({ fstop: +v }));
  slider('grain', () => P.grain, (x) => stage.setPhoto({ grain: x }), (x) => Math.round(x * 100));
  slider('vignette', () => P.vignette, (x) => stage.setPhoto({ vignette: x }), (x) => Math.round(x * 100));
  slider('bloom', () => P.bloom, (x) => stage.setPhoto({ bloom: x }), (x) => Math.round(x * 100));
  slider('ca', () => P.ca, (x) => stage.setPhoto({ ca: x }), (x) => Math.round(x * 100));
  slider('look', () => P.look, (x) => stage.setPhoto({ look: x }), (x) => Math.round(x * 100));

  // realism
  const cw = $('condition');
  for (const [k, c] of Object.entries(CONDITIONS)) cw.insertAdjacentHTML('beforeend', `<button data-v="${k}">${c.name}</button>`);
  const refreshCondition = seg('condition', () => Object.keys(CONDITIONS).find((k) => matches(state, CONDITIONS[k])) || '', (k) => {
    const { name, ...c } = CONDITIONS[k];
    Object.assign(state, c);
    applyCondition();
    refreshers.forEach((f) => f());
    applyLayout({ reframe: 'fit' }); // warp changes the stack height
  });
  presetRefreshers.push(refreshCondition);
  slider('wear', () => state.wear, (x) => { state.wear = x; clearTimeout(wearT); wearT = setTimeout(() => { sleeve.setWear(x); insert.setWear(x * 0.5); stage.invalidate(); }, 60); }, (x) => Math.round(x * 100));
  slider('warp', () => state.warp, (x) => { state.warp = x; sleeve.setWarp(x); insert.setWarp(x * 0.4); applyLayout({ reframe: 'fit' }); }, (x) => x.toFixed(2) + 'cm');
  slider('dust', () => state.dust, (x) => { state.dust = x; vinyl.setDust(x); stage.invalidate(); }, (x) => Math.round(x * 100));

  // background
  const bgw = $('bgs');
  const setMode = (m) => { state.bgMode = m; applyBg(); };
  BGS.forEach((c) => {
    const b = document.createElement('button');
    b.style.background = c; b.dataset.c = c; b.title = c;
    b.onclick = () => { state.bg = c; setMode('color'); };
    bgw.appendChild(b);
  });
  const tb = document.createElement('button');
  tb.className = 'transparent'; tb.title = 'Transparent'; tb.dataset.c = 'transparent';
  tb.onclick = () => setMode('transparent');
  bgw.appendChild(tb);
  const mb = document.createElement('button');
  mb.className = 'media'; mb.title = 'Image / video'; mb.dataset.c = 'media'; mb.hidden = true;
  mb.onclick = () => setMode('media');
  bgw.appendChild(mb);
  $('bgColor').oninput = (e) => { state.bg = e.target.value; setMode('color'); };
  $('bgPick').onclick = () => { $('bgFile').value = ''; $('bgFile').click(); };
  $('bgFile').onchange = (e) => { const f = e.target.files[0]; if (f) setBgFile(f); };
  $('bgClear').onclick = clearBgMedia;
  const row = $('bgMediaRow');
  row.ondragover = (e) => { e.preventDefault(); row.classList.add('drag'); };
  row.ondragleave = () => row.classList.remove('drag');
  row.ondrop = (e) => { e.preventDefault(); row.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) setBgFile(f); };
  refreshBg = () => {
    bgw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', state.bgMode === 'color' ? b.dataset.c === state.bg : b.dataset.c === state.bgMode));
    mb.hidden = !bgMedia;
    if (bgMedia) mb.style.backgroundImage = `url("${bgMedia.thumb}")`;
    $('bgColor').value = state.bg;
    $('bgClear').hidden = !bgMedia;
    $('bgPick').textContent = bgMedia ? 'Replace…' : 'Choose file…';
    const v = bgMedia?.el instanceof HTMLVideoElement ? bgMedia.el : null;
    $('bgHint').textContent = !bgMedia
      ? 'Drop a photo or a video here to use it as the backdrop. Shadows fall onto it.'
      : `${bgMedia.name} · ${bgMedia.w}×${bgMedia.h}${v ? ` · ${Number.isFinite(v.duration) ? v.duration.toFixed(1) + 's ' : ''}video` : ''} · fills the frame (cropped to fit).`;
    updatePngHint();
    refreshVidUI();
  };
  applyBg();

  // export
  seg('imgSize', () => state.imgSize, (v) => { state.imgSize = +v; updatePngHint(); });
  $('exportPng').onclick = exportPng;
  // any change to the loop settings restarts a running preview so it always shows what will be exported
  const vidSet = (k, v) => { state.vid[k] = v; if (preview) { stopPreview(); startPreview(); } refreshVidUI(); };
  seg('vidMotion', () => state.vid.motion, (v) => vidSet('motion', v));
  seg('vidFps', () => state.vid.fps, (v) => vidSet('fps', +v));
  refreshVidDur = slider('vidDur', () => state.vid.duration, (x) => vidSet('duration', x), (x) => +x.toFixed(1) + 's');
  slider('vidTurns', () => state.vid.turns, (x) => vidSet('turns', x), (x) => x);
  $('previewLoop').onclick = togglePreview;
  refreshVidUI();
  $('exportMp4').onclick = exportMp4;

  $('play').onclick = togglePreview;
  // small screens show one panel at a time under the preview
  const tabs = $('tabs').querySelectorAll('button');
  const setTab = (v) => { $('app').dataset.tab = v; tabs.forEach((b) => b.classList.toggle('on', b.dataset.v === v)); };
  tabs.forEach((b) => (b.onclick = () => { setTab(b.dataset.v); $('app').querySelector(b.dataset.v === 'design' ? '.panel.left' : '.panel.right').scrollTop = 0; }));
  setTab($('app').dataset.tab);
  $('reframe').onclick = () => { stage.frame({}, false); refreshCam(); };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePreview(); }
    if (e.key === 'f') { stage.frame({}, false); refreshCam(); }
  });
  updatePngHint();
  refreshSlide();
}

// ---------------------------------------------------------------- background image / video
function applyBg() {
  if (state.bgMode === 'media' && !bgMedia) state.bgMode = 'color';
  stage.setBackground(state.bg, state.bgMode === 'transparent', state.bgMode === 'media' ? bgMedia : null);
  // don't keep decoding a backdrop video that isn't shown
  const v = bgMedia?.el instanceof HTMLVideoElement ? bgMedia.el : null;
  if (v) state.bgMode === 'media' ? v.play().catch(() => {}) : v.pause();
  refreshBg();
}
const VID_DUR_MAX = 15;
function releaseBgMedia() {
  if (!bgMedia) return;
  if (bgMedia.el instanceof HTMLVideoElement) bgMedia.el.pause();
  URL.revokeObjectURL(bgMedia.url);
  bgMedia = null;
}
function loadVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', src: url });
    v.onloadeddata = () => res(v);
    v.onerror = () => rej(new Error('This video format cannot be read by the browser (try MP4 / H.264 or WebM).'));
  });
}
async function setBgFile(file) {
  const url = URL.createObjectURL(file);
  try {
    let el, w, h, thumb;
    if (file.type.startsWith('video/')) {
      el = await loadVideo(url);
      w = el.videoWidth; h = el.videoHeight;
      const c = document.createElement('canvas');
      c.width = 96; c.height = Math.round((96 * h) / w);
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      thumb = c.toDataURL();
      // a loop exactly as long as the backdrop video makes both loop together seamlessly
      // (not rounded to the slider step: a 6.04s clip in a 6.0s loop would jump at the seam)
      if (Number.isFinite(el.duration) && el.duration <= 30) {
        $('vidDur').max = Math.max(VID_DUR_MAX, Math.ceil(el.duration));
        state.vid.duration = el.duration;
        refreshVidDur();
      }
    } else {
      el = await loadImage(url);
      w = el.naturalWidth; h = el.naturalHeight; thumb = url;
    }
    releaseBgMedia();
    bgMedia = { el, w, h, thumb, url, name: file.name };
    state.bgMode = 'media';
    applyBg();
    if (preview) { stopPreview(); startPreview(); }
  } catch (e) {
    URL.revokeObjectURL(url);
    alert(e.message || 'Could not load this file.');
  }
}
function clearBgMedia() {
  releaseBgMedia();
  $('vidDur').max = VID_DUR_MAX;
  if (state.vid.duration > VID_DUR_MAX) state.vid.duration = VID_DUR_MAX;
  refreshVidDur();
  applyBg();
}

// ---------------------------------------------------------------- collection (saved vinyls)
// A project is one release: the artwork slots + the vinyl & sleeve settings. The studio (scene, camera, light,
// background, export) is left alone when switching, so the whole collection can be shot the same way.
const PROJECT_KEYS = ['vinyl', 'vinylColors', 'finish', 'edge', 'varnish', 'glint', 'wear', 'warp', 'dust'];
let DEFAULTS; // settings at boot, for "+ New"
let project = { id: null, name: '' };
let savedSnap = '';

const settingsOf = () => structuredClone({ ...Object.fromEntries(PROJECT_KEYS.map((k) => [k, state[k]])), seeds, splitAngle });
// cheap change detector: settings + the image behind each slot (a replaced file gets a new blob: URL)
const snapshot = () => JSON.stringify([settingsOf(), Object.keys(SLOTS).map((k) => images[k]?.src || '')]);

function applySettings(s) {
  for (const k of PROJECT_KEYS) if (s[k] !== undefined) state[k] = structuredClone(s[k]);
  // a vinyl saved before a finish was added lacks its colours (or names a finish that no longer exists)
  state.vinylColors = { ...structuredClone(DEFAULTS.vinylColors), ...state.vinylColors };
  if (!VINYLS[state.vinyl]) state.vinyl = DEFAULTS.vinyl;
  Object.assign(seeds, s.seeds);
  if (s.splitAngle !== undefined) splitAngle = s.splitAngle;
  sleeve.setFinish(state.finish);
  insert.setFinish(state.finish === 'gloss' ? 'satin' : 'matte');
  sleeve.setEdge(state.edge);
  $('edgeColor').value = state.edge;
  sleeve.setVarnish({ on: state.varnish });
  applyCondition();
  refreshVarnishUI();
  applyVinyl(); renderSwatches(); renderVinylOpts();
  refreshers.forEach((f) => f());
  refreshPresets();
  applyLayout({ reframe: 'fit' }); // warp changes the stack height
}

// fills every slot; a missing or unreadable entry empties a varnish slot or falls back to the default artwork
// (never keeps the previous vinyl's image)
async function applyImages(blobs) {
  const load = async (src) => { try { return await loadImage(src); } catch { if (src.startsWith('blob:')) URL.revokeObjectURL(src); return null; } };
  const loaded = await Promise.all(Object.entries(SLOTS).map(async ([k, s]) => {
    let img = blobs?.[k] ? await load(URL.createObjectURL(blobs[k])) : null;
    if (!img && !(s.varnish && blobs)) img = await load(s.url);
    return [k, img];
  }));
  for (const [k, img] of loaded) {
    if (img) { setImage(k, img); applySlot(k); } else if (SLOTS[k].varnish) clearSlot(k);
  }
}

function coverThumb() {
  const img = images.coverFront;
  if (!img) return '';
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  c.getContext('2d').drawImage(img, 0, 0, 96, 96);
  return c.toDataURL('image/jpeg', 0.8);
}
const confirmDiscard = () => savedSnap === snapshot()
  || confirm(`“${project.name || 'Untitled vinyl'}” has unsaved changes that will be lost. Continue?`);
function refreshDirty() { $('projDirty').hidden = savedSnap === snapshot(); }
function markSaved() { savedSnap = snapshot(); refreshDirty(); }

let saving = false;
async function saveProject() {
  if (saving) return; // ⌘S / Enter bypass the disabled button: a second save would create a duplicate
  saving = true;
  const name = $('projName').value.trim() || 'Untitled vinyl';
  $('projSave').disabled = true;
  // captured up front: edits made while the images are being read must stay "unsaved"
  const settings = settingsOf(), snap = snapshot(), thumb = coverThumb();
  const srcs = Object.keys(SLOTS).filter((k) => images[k]).map((k) => [k, images[k].src]);
  try {
    const blobs = {};
    await Promise.all(srcs.map(async ([k, src]) => { blobs[k] = await (await fetch(src)).blob(); }));
    const prev = project.id && (await getProject(project.id));
    const now = Date.now();
    project = { id: project.id || newId(), name };
    await putProject({ ...project, created: prev?.created || now, updated: now, thumb, settings, images: blobs });
    $('projName').value = name;
    savedSnap = snap;
    refreshDirty();
    flashHint(`Saved “${name}”.`);
  } catch (e) {
    console.error(e);
    alert('Could not save: ' + e.message);
  } finally {
    saving = false;
    $('projSave').disabled = false;
    renderProjects();
  }
}

async function openProject(id) {
  if (id === project.id || !confirmDiscard()) return;
  const p = await getProject(id);
  if (!p) return renderProjects();
  busy(true, `Opening “${p.name}”…`, 0.5);
  try {
    stopPreview();
    await applyImages(p.images);
    applySettings(p.settings);
    project = { id: p.id, name: p.name };
    $('projName').value = p.name;
    markSaved();
  } catch (e) {
    console.error(e);
    alert(`Could not open “${p.name}”: ${e.message}`);
  } finally {
    busy(false);
    renderProjects();
  }
}

async function newProject() {
  if (!confirmDiscard()) return;
  busy(true, 'New vinyl…', 0.5);
  try {
    stopPreview();
    await applyImages(null);
    applySettings(DEFAULTS);
    project = { id: null, name: '' };
    $('projName').value = '';
    markSaved();
  } finally {
    busy(false);
    renderProjects();
  }
  $('projName').focus();
}

async function removeProject(p) {
  if (!confirm(`Delete “${p.name}” from the collection? This cannot be undone.`)) return;
  await deleteProject(p.id);
  if (p.id === project.id) { project.id = null; savedSnap = ''; refreshDirty(); } // what's on screen is now unsaved
  renderProjects();
}

async function renderProjects() {
  const wrap = $('projects');
  const list = await listProjects();
  wrap.innerHTML = '';
  for (const p of list) {
    const b = document.createElement('div');
    b.className = 'project' + (p.id === project.id ? ' on' : '');
    b.role = 'button';
    b.innerHTML = `<i></i><div><b></b><small>${new Date(p.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</small></div><button class="del" title="Delete">×</button>`;
    b.querySelector('b').textContent = p.name;
    if (p.thumb) b.querySelector('i').style.backgroundImage = `url("${p.thumb}")`;
    b.onclick = () => openProject(p.id);
    b.querySelector('.del').onclick = (e) => { e.stopPropagation(); removeProject(p); };
    wrap.appendChild(b);
  }
  $('projExport').disabled = !list.length;
}

let hintT;
function flashHint(text) {
  const el = $('projHint'), def = el.dataset.def ??= el.textContent;
  el.textContent = text;
  clearTimeout(hintT);
  hintT = setTimeout(() => (el.textContent = def), 3500);
}

function buildCollection() {
  $('projSave').onclick = saveProject;
  $('projNew').onclick = newProject;
  $('projName').onkeydown = (e) => { if (e.key === 'Enter') saveProject(); };
  $('projExport').onclick = async () => {
    busy(true, 'Packing the collection…', 0.5);
    try { download(await exportBackup(await listProjects()), `vinyl-collection-${stamp()}.json`); } finally { busy(false); }
  };
  $('projImport').onclick = () => { $('backupFile').value = ''; $('backupFile').click(); };
  $('backupFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    busy(true, 'Importing…', 0.5);
    try {
      const { added, updated, skipped, ids } = await importBackup(f);
      // the vinyl on screen was overwritten in the collection: it no longer matches what's stored
      if (project.id && ids.includes(project.id)) { savedSnap = ''; refreshDirty(); }
      flashHint(`Imported ${added} new vinyl${added === 1 ? '' : 's'}${updated ? `, updated ${updated}` : ''}`
        + `${skipped ? ` (${skipped} unreadable skipped)` : ''}.`);
    } catch (err) {
      alert(err.message);
    } finally {
      busy(false);
      renderProjects();
    }
  };
  // ⌘S / Ctrl+S saves the current vinyl
  window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); } });
  // only guards a vinyl from the collection: tweaking the default one without ever saving shouldn't nag on reload
  window.addEventListener('beforeunload', (e) => { if (project.id && savedSnap !== snapshot()) e.preventDefault(); });
}

// ---------------------------------------------------------------- loop preview
// Plays exactly the motion the MP4 will contain, in real time, in the video's frame format.
let preview = null;
function videoDims(frame) { // 1080 on the short side, even sizes for the encoder
  const a = aspectOf(frame);
  return a >= 1 ? [Math.round((1080 * a) / 2) * 2, 1080] : [1080, Math.round(1080 / a / 2) * 2];
}
const motionOpts = () => ({ ...state.vid, flip: !LAYOUTS[state.layout].upright });
function refreshVidUI() {
  $('vidTurnsRow').style.display = state.vid.motion === 'turntable' ? 'none' : '';
  $('motionHint').textContent = MOTIONS[state.vid.motion];
  const [w, h] = videoDims(state.frame);
  const alpha = state.bgMode === 'transparent';
  $('exportMp4').textContent = alpha ? 'Render MOV (transparent)' : 'Render MP4';
  $('vidHint').textContent = `${w} × ${h} · ${state.frame} (frame ratio at the top) · seamless loop · `
    + (alpha ? 'ProRes 4444 with alpha: opens in QuickTime, Final Cut, Premiere, After Effects, DaVinci. Large files (~30 MB per second).' : 'H.264.');
  const on = !!preview;
  for (const id of ['play', 'previewLoop']) $(id).classList.toggle('on', on);
  $('previewLoop').textContent = on ? '■ Stop preview' : '▶ Preview loop';
  // the topbar button collapses to its icon on small screens
  $('play').innerHTML = on ? '■<span class="lbl"> Stop preview</span>' : '▶<span class="lbl"> Preview loop</span>';
  $('play').ariaLabel = on ? 'Stop preview' : 'Preview loop';
  $('loopBadge').hidden = !on;
}
function startPreview() {
  stage.controls.enabled = false;
  stage.loScale = 0.75;
  preview = { t0: performance.now(), base: beginMotion(stage, vinyl, motionOpts()) };
  const v = bgMedia?.el instanceof HTMLVideoElement && state.bgMode === 'media' ? bgMedia.el : null;
  if (v) { v.currentTime = 0; v.play().catch(() => {}); }
  refreshVidUI();
}
function stopPreview() {
  if (!preview) return;
  endMotion(preview.base);
  stage.controls.enabled = true;
  stage.loScale = 0.5;
  preview = null;
  stage.invalidate();
  refreshVidUI();
}
function togglePreview() { preview ? stopPreview() : startPreview(); }
function tickPreview(now) {
  const v = state.vid;
  const secs = (now - preview.t0) / 1000;
  const t = (secs / v.duration) % 1;
  applyMotion(preview.base, t, v);
  stage.invalidate(v.motion === 'turntable'); // turntable moves the shadows, spin/sway don't
  $('loopBadge').textContent = `${state.frame} · ${(t * v.duration).toFixed(1)}s / ${+v.duration.toFixed(2)}s`;
}

// ---------------------------------------------------------------- export
function exportDims(frame, long) {
  const a = aspectOf(frame);
  return a >= 1 ? [long, Math.round(long / a)] : [Math.round(long * a), long];
}
function updatePngHint() {
  const [w, h] = exportDims(state.frame, state.imgSize);
  $('pngHint').textContent = `${w} × ${h}px · ${state.frame} · 200-sample render${state.bgMode === 'transparent' ? ' · transparent' : ''}`;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function busy(on, text = '', p = 0) {
  $('busy').hidden = !on;
  $('busyText').textContent = text;
  $('busyBar').style.width = Math.round(p * 100) + '%';
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

async function exportPng() {
  updatePngHint();
  const [w, h] = exportDims(state.frame, state.imgSize);
  busy(true, `Rendering ${w}×${h}…`, 0.3);
  await new Promise((r) => setTimeout(r, 50));
  try {
    const out = stage.renderToCanvas(w, h, 200);
    busy(true, 'Encoding PNG…', 0.8);
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    window.__lastExport = { type: 'png', w, h, size: blob.size };
    download(blob, `vinyl-${state.layout}-${w}x${h}-${stamp()}.png`);
  } catch (e) {
    console.error(e);
    alert('Export failed: ' + e.message);
  } finally {
    busy(false);
  }
}

async function exportMp4() {
  stopPreview();
  const f = state.frame;
  const [w, h] = videoDims(f);
  const alpha = state.bgMode === 'transparent';
  const ext = alpha ? 'mov' : 'mp4';
  $('exportMp4').disabled = true;
  rendering = true;
  try {
    const blob = await renderLoop({
      stage, vinyl, w, h, ...motionOpts(), alpha,
      onProgress: (p) => busy(true, `Rendering loop… ${Math.round(p * 100)}%`, p),
      onStatus: (t) => busy(true, t, 1),
    });
    window.__lastExport = { type: ext, w, h, size: blob.size };
    download(blob, `vinyl-loop-${f.replace(':', 'x')}-${stamp()}.${ext}`);
  } catch (e) {
    console.error(e);
    alert('Video export failed: ' + e.message);
  } finally {
    rendering = false;
    busy(false);
    $('exportMp4').disabled = false;
    stage.invalidate();
  }
}

// ---------------------------------------------------------------- loop
let rendering = false;
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!rendering) {
    if (preview) tickPreview(now);
    else stage.controls.update();
    stage.step();
  }
  requestAnimationFrame(tick);
}

// any UI interaction may change the scene -> restart progressive accumulation
['input', 'change', 'click', 'drop'].forEach((ev) => window.addEventListener(ev, () => setTimeout(() => { stage.invalidate(); refreshPresets(); if (DEFAULTS) refreshDirty(); }), true));

// "Advanced" folds remember whether they were left open (per browser)
document.querySelectorAll('details.adv[data-k]').forEach((d) => {
  const key = 'adv.' + d.dataset.k;
  try { d.open = localStorage.getItem(key) === '1'; } catch { /* storage blocked */ }
  d.ontoggle = () => { try { localStorage.setItem(key, d.open ? '1' : '0'); } catch { /* storage blocked */ } };
});

// ---------------------------------------------------------------- boot
(async function boot() {
  buildLayouts();
  buildSlots();
  buildControls();
  buildCollection();
  renderSwatches();
  renderVinylOpts();
  await Promise.all(Object.entries(SLOTS).map(async ([k, s]) => {
    try { images[k] = await loadImage(s.url); } catch { /* optional */ }
  }));
  Object.keys(SLOTS).forEach((k) => images[k] && applySlot(k));
  refreshVarnishUI();
  applyVinyl();
  sleeve.setFinish(state.finish);
  applyCondition();
  fitViewport();
  stage.setLight(LIGHT_PRESETS['Window']);
  applyLayout();
  refreshCam();
  refreshLight();
  refreshPresets();
  DEFAULTS = settingsOf();
  markSaved();
  renderProjects();
  requestAnimationFrame(tick);
  window.__app = { state, stage, vinyl, applyLayout, LAYOUTS, exportPng, exportMp4 };
})();
