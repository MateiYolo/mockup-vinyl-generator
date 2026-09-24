import * as THREE from 'three';

// Physical dimensions (cm). Disc textures map planar: canvas covers [-R, R] on both axes.
export const R = 15.0;

// ---------- small seeded noise helpers ----------
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}

function makeNoise(seed) {
  const rand = rng(seed * 9301 + 49297);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = new Float32Array(256);
  for (let i = 0; i < 256; i++) grad[i] = rand();
  const fade = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const a = grad[perm[perm[X] + Y]], b = grad[perm[perm[X + 1] + Y]];
    const c = grad[perm[perm[X] + Y + 1]], d = grad[perm[perm[X + 1] + Y + 1]];
    const u = fade(xf), v = fade(yf);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  };
  const fbm = (x, y, oct = 5) => {
    let s = 0, amp = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += amp * noise(x * f, y * f); n += amp; amp *= 0.5; f *= 2.03; }
    return s / n;
  };
  return { noise, fbm };
}

const hexToRgb = (hex) => {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// ---------- groove maps ----------
// Returns { surface: R=bump, G=roughness ; aniso: RG=direction, B=strength }
export function makeGrooveMaps(size = 4096) {
  // 1D radial profile
  const N = 16384;
  const bump = new Float32Array(N), rough = new Float32Array(N), aniso = new Float32Array(N);
  const n = makeNoise(7);
  const grooveStart = 6.0, grooveEnd = 14.5;
  const gaps = [0.19, 0.41, 0.6, 0.81].map((f) => grooveEnd - f * (grooveEnd - grooveStart));
  for (let i = 0; i < N; i++) {
    const r = (i / (N - 1)) * R;
    let b = 0.5, ro = 0.16, an = 0.12;
    if (r >= grooveStart && r <= grooveEnd) {
      const gapD = Math.min(...gaps.map((g) => Math.abs(r - g)));
      // groove pitch & modulation vary with the music: louder passages = wider, rougher bands
      const loud = n.fbm(r * 1.7, 3.3, 4);
      const pitch = 0.045 + loud * 0.03;
      const ring = Math.sin(r * Math.PI * 2 / pitch) * 0.5 + 0.5;
      const band = n.fbm(r * 6.1, 0.5, 4) - 0.5;
      // smooth track gaps (hard edges alias through the bump derivatives)
      const g = Math.exp(-Math.pow(gapD / 0.05, 2));
      const edge = Math.min(1, (r - grooveStart) / 0.08, (grooveEnd - r) / 0.08);
      const gv = g + (1 - g) * (1 - edge);
      b = (0.5 + ring * (0.08 + loud * 0.1) + band * 0.3) * (1 - gv) + 0.42 * gv;
      ro = (0.24 + loud * 0.16 + band * 0.1 + ring * 0.05) * (1 - gv) + 0.1 * gv;
      an = (0.75 + loud * 0.25) * (1 - gv) + 0.25 * gv;
    } else if (r > 5.2 && r < grooveStart) {
      // run-out: glossy with a couple of locked grooves
      const ring = Math.sin(r * Math.PI * 2 / 0.3) * 0.5 + 0.5;
      b = 0.5 + ring * 0.03; ro = 0.11; an = 0.35;
    } else if (r > grooveEnd && r < 14.72) {
      b = 0.47; ro = 0.1; an = 0.3;
    }
    bump[i] = b; rough[i] = ro; aniso[i] = an;
  }

  // wear layer: R = scratches, G = smudges / fingerprints, B = waviness
  const wear = canvas(size);
  const wctx = wear.getContext('2d', { willReadFrequently: true });
  wctx.fillStyle = '#000';
  wctx.fillRect(0, 0, size, size);
  const lo = canvas(512);
  const lctx = lo.getContext('2d');
  const limg = lctx.createImageData(512, 512);
  const n2 = makeNoise(21);
  for (let py = 0; py < 512; py++) {
    for (let px = 0; px < 512; px++) {
      const o = (py * 512 + px) * 4;
      const sm = Math.max(0, n2.fbm(px / 60, py / 60, 5) - 0.55) * 4;
      // a few oval fingerprint blobs
      limg.data[o + 1] = Math.min(255, sm * 255);
      limg.data[o + 2] = n.fbm(px / 110 + 9, py / 110, 3) * 255;
      limg.data[o + 3] = 255;
    }
  }
  lctx.putImageData(limg, 0, 0);
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(lo, 0, 0, size, size);
  wctx.globalCompositeOperation = 'lighter';
  const rand = rng(1234);
  const c = size / 2, pxPerCm = size / (2 * R);
  wctx.lineCap = 'round';
  // tangential handling scuffs
  for (let i = 0; i < 90; i++) {
    const rr = (5.4 + rand() * 9.4) * pxPerCm;
    const a0 = rand() * Math.PI * 2, len = 0.05 + rand() * 0.5;
    wctx.strokeStyle = `rgba(255,0,0,${0.15 + rand() * 0.5})`;
    wctx.lineWidth = 0.8 + rand() * 1.8;
    wctx.beginPath();
    wctx.arc(c, c, rr, a0, a0 + len);
    wctx.stroke();
  }
  // random hairlines
  for (let i = 0; i < 40; i++) {
    const x = rand() * size, y = rand() * size, a = rand() * Math.PI, l = size * (0.02 + rand() * 0.18);
    wctx.strokeStyle = `rgba(255,0,0,${0.1 + rand() * 0.45})`;
    wctx.lineWidth = 0.6 + rand() * 1.2;
    wctx.beginPath();
    wctx.moveTo(x, y);
    wctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (rand() - 0.5) * l * 0.2, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    wctx.stroke();
  }
  const wd = wctx.getImageData(0, 0, size, size).data;

  const sc = canvas(size);
  const sctx = sc.getContext('2d');
  const simg = sctx.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size - 0.5) * 2 * R;
      const y = ((py + 0.5) / size - 0.5) * 2 * R;
      const r = Math.min(Math.hypot(x, y), R);
      const k = Math.round((r / R) * (N - 1));
      const o = (py * size + px) * 4;
      const scratch = wd[o] / 255, smudge = wd[o + 1] / 255, wave = wd[o + 2] / 255 - 0.5;
      simg.data[o] = Math.max(0, Math.min(1, bump[k] + wave * 0.5 - scratch * 0.2)) * 255;
      simg.data[o + 1] = Math.min(1, rough[k] + scratch * 0.4 + smudge * 0.14) * 255;
      simg.data[o + 2] = 0;
      simg.data[o + 3] = 255;
    }
  }
  sctx.putImageData(simg, 0, 0);

  const AS = 1024;
  const ac = canvas(AS);
  const actx = ac.getContext('2d');
  const aimg = actx.createImageData(AS, AS);
  for (let py = 0; py < AS; py++) {
    for (let px = 0; px < AS; px++) {
      // uv space: u right, v up (canvas row 0 is v=1 because of flipY)
      const u = (px + 0.5) / AS - 0.5;
      const v = 0.5 - (py + 0.5) / AS;
      const len = Math.hypot(u, v) || 1;
      const tx = -v / len, ty = u / len; // tangent to circle
      const r = Math.min(len * 2 * R, R);
      const k = Math.round((r / R) * (N - 1));
      const o = (py * AS + px) * 4;
      aimg.data[o] = (tx * 0.5 + 0.5) * 255;
      aimg.data[o + 1] = (ty * 0.5 + 0.5) * 255;
      aimg.data[o + 2] = aniso[k] * 255;
      aimg.data[o + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);

  const surface = new THREE.CanvasTexture(sc);
  surface.colorSpace = THREE.NoColorSpace;
  surface.anisotropy = 8;
  const anisoTex = new THREE.CanvasTexture(ac);
  anisoTex.colorSpace = THREE.NoColorSpace;
  anisoTex.anisotropy = 8;
  return { surface, aniso: anisoTex };
}

// ---------- paper grain ----------
export function makePaperGrain(size = 512) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n = makeNoise(11);
  const rand = rng(99);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const f = n.fbm(px / 18, py / 18, 3) * 0.6 + rand() * 0.4;
      const o = (py * size + px) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = f * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---------- disc color textures ----------
function toTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function makeMarble({ c1, c2, c3, seed = 1, swirl = 1 }, size = 1024) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n = makeNoise(seed);
  const A = hexToRgb(c1), B = hexToRgb(c2), C = hexToRgb(c3);
  const off = seed * 13.37;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let x = (px / size - 0.5) * 2, y = (py / size - 0.5) * 2;
      const r = Math.hypot(x, y);
      const a = Math.atan2(y, x) + swirl * 2.2 * r;
      // anisotropic stretch along the tangent -> pressing streaks
      const sx = Math.cos(a) * r, sy = Math.sin(a) * r;
      const qx = n.fbm(sx * 1.6 + off, sy * 1.6, 4);
      const qy = n.fbm(sx * 1.6 + 5.2, sy * 1.6 + off, 4);
      const v = n.fbm(sx * 2.2 + qx * 3.5, sy * 2.2 + qy * 3.5, 5);
      const vein = Math.pow(1 - Math.abs(Math.sin(v * 9 + qx * 4)), 22) + 0.35 * Math.pow(1 - Math.abs(Math.sin(v * 23 + qy * 5)), 30);
      const cloud = Math.max(0, n.fbm(sx * 1.2 - off, sy * 1.2 + 3, 4) - 0.52) * 3.2;
      const t1 = Math.min(1, vein * 0.95);
      const t2 = Math.min(1, cloud);
      const o = (py * size + px) * 4;
      for (let k = 0; k < 3; k++) {
        let col = A[k] + (C[k] - A[k]) * t2 * 0.8;
        col = col + (B[k] - col) * t1;
        img.data[o + k] = col;
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

export function makeSplatter({ c1, c2, c3, seed = 1 }, size = 2048) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const rand = rng(seed * 31 + 7);
  ctx.fillStyle = c1;
  ctx.fillRect(0, 0, size, size);
  const blob = (x, y, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    const pts = 9;
    const P = Array.from({ length: pts }, (_, i) => {
      const a = (i / pts) * Math.PI * 2, rr = r * (0.78 + rand() * 0.44);
      return [x + Math.cos(a) * rr, y + Math.sin(a) * rr];
    });
    const mid = (i) => { const p = P[i % pts], q = P[(i + 1) % pts]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
    ctx.moveTo(...mid(0));
    for (let i = 1; i <= pts; i++) ctx.quadraticCurveTo(...P[i % pts], ...mid(i));
    ctx.closePath();
    ctx.fill();
  };
  const colors = [c2, c3];
  for (let i = 0; i < 90; i++) {
    const col = colors[i % 2];
    const cx = rand() * size, cy = rand() * size;
    const r = size * (0.004 + Math.pow(rand(), 3) * 0.03);
    blob(cx, cy, r, col);
    // droplets flung outward
    const drops = 3 + Math.floor(rand() * 8);
    const dir = rand() * Math.PI * 2;
    for (let d = 0; d < drops; d++) {
      const dist = r * (1.5 + rand() * 4);
      const a = dir + (rand() - 0.5) * 1.2;
      blob(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist, r * (0.08 + rand() * 0.25), col);
    }
  }
  return toTexture(c);
}

export function makeSplit({ c1, c2, angle = 0, blend = 0.02 }, size = 1024) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a) * size / 2, dy = Math.sin(a) * size / 2;
  const g = ctx.createLinearGradient(size / 2 - dx, size / 2 - dy, size / 2 + dx, size / 2 + dy);
  g.addColorStop(0, c1);
  g.addColorStop(Math.max(0, 0.5 - blend), c1);
  g.addColorStop(Math.min(1, 0.5 + blend), c2);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return toTexture(c);
}

// Crop an uploaded top-down disc image to its alpha bounds so the disc fills the texture.
export function discTextureFromImage(image, size = 2048) {
  const w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(image, 0, 0);
  const data = pctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (data[(y * w + x) * 4 + 3] > 40) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX) { minX = 0; minY = 0; maxX = w; maxY = h; }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rad = Math.max(maxX - minX, maxY - minY) / 2;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  // slight overscan so the rim samples real vinyl color, not the transparent edge
  const k = 0.985;
  ctx.drawImage(image, cx - rad * k, cy - rad * k, rad * 2 * k, rad * 2 * k, 0, 0, size, size);
  return toTexture(c);
}

// Average color of the image border (used for sleeve edges / spine)
export function borderColor(image) {
  const s = 64;
  const c = canvas(s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, s, s);
  const d = ctx.getImageData(0, 0, s, s).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < s; i++) {
    for (const [x, y] of [[i, 0], [i, s - 1], [0, i], [s - 1, i]]) {
      const o = (y * s + x) * 4;
      if (d[o + 3] < 128) continue;
      r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
    }
  }
  if (!n) return '#f2f0ec';
  return '#' + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
}

// ---------- dust (alpha map, shared by both faces of the disc) ----------
export function makeDustMap(size = 2048, seed = 3) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const rand = rng(seed);
  // fine specks
  for (let i = 0; i < 1100; i++) {
    const x = rand() * size, y = rand() * size, r = 0.35 + Math.pow(rand(), 5) * 2;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.pow(rand(), 2) * 0.85})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // lint fibres
  ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    let x = rand() * size, y = rand() * size, a = rand() * Math.PI * 2;
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + rand() * 0.5})`;
    ctx.lineWidth = 0.6 + rand() * 0.9;
    ctx.beginPath(); ctx.moveTo(x, y);
    const steps = 6 + Math.floor(rand() * 10);
    for (let k = 0; k < steps; k++) {
      a += (rand() - 0.5) * 1.1;
      x += Math.cos(a) * 4; y += Math.sin(a) * 4;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- label paper: grain + stamped rings ----------
export function makeLabelBump(size = 1024) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n = makeNoise(5), rand = rng(77);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / size - 0.5, v = py / size - 0.5, r = Math.hypot(u, v) * 2;
      let h = 0.5 + (n.fbm(px / 5, py / 5, 3) - 0.5) * 0.35 + (rand() - 0.5) * 0.12;
      h += Math.exp(-Math.pow((r - 0.36) / 0.012, 2)) * 0.35; // stamper ring
      h += Math.exp(-Math.pow((r - 0.14) / 0.01, 2)) * 0.2;
      h += (n.fbm(px / 90, py / 90, 3) - 0.5) * 0.3; // slight waviness of the glued paper
      const o = (py * size + px) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.max(0, Math.min(1, h)) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---------- sleeve board surface: R = height (fibres, ring wear), G = roughness ----------
export function makeBoardSurface(size = 2048, ringFrac = 15.05 / 31.4) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n = makeNoise(13), rand = rng(31);
  const lo = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) lo[y * 256 + x] = n.fbm(x / 40, y / 40, 4);
  const cx = 0.5 + 0.01, cy = 0.5 - 0.006;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / size, v = py / size;
      const L = lo[((py >> 3) & 255) * 256 + ((px >> 3) & 255)];
      // board fibres: anisotropic noise (stretched along x) + tooth
      let h = 0.5 + (n.noise(px / 2.2, py / 9) - 0.5) * 0.35 + (rand() - 0.5) * 0.25;
      // ring wear: the record pressing through the board
      const rr = Math.hypot(u - cx, v - cy);
      const ring = Math.exp(-Math.pow((rr - ringFrac) / 0.004, 2));
      h += ring * (0.5 + (L - 0.5) * 1.5);
      h += (L - 0.5) * 0.4;
      const o = (py * size + px) * 4;
      img.data[o] = Math.max(0, Math.min(1, h)) * 255;
      img.data[o + 1] = Math.min(1, 0.82 + (L - 0.5) * 0.35 + (rand() - 0.5) * 0.08 + ring * 0.1) * 255;
      img.data[o + 2] = 0;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- printed artwork + handling wear ----------
let grimeCanvas = null;
function grime(size) {
  if (grimeCanvas && grimeCanvas.width === size) return grimeCanvas;
  const s = 256, c = canvas(s), ctx = c.getContext('2d'), img = ctx.createImageData(s, s);
  const n = makeNoise(41);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const v = n.fbm(x / 30, y / 30, 5);
    const o = (y * s + x) * 4;
    img.data[o] = 255 - v * 40; img.data[o + 1] = 255 - v * 44; img.data[o + 2] = 255 - v * 52; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grimeCanvas = canvas(size);
  grimeCanvas.getContext('2d').drawImage(c, 0, 0, size, size);
  return grimeCanvas;
}

export function composeArtwork(image, wear = 0.4, seed = 1, size = 2048) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, size, size);
  const rand = rng(seed * 97 + 3);
  // uneven ink / paper tone: multiply a soft warm grime
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.12 + wear * 0.4;
  ctx.drawImage(grime(size), 0, 0);
  ctx.globalAlpha = 1;
  if (wear > 0) {
    ctx.globalCompositeOperation = 'screen';
    // ring wear: lightened ring where the record presses
    const rf = (15.05 / 31.4) * size;
    const cx = size * 0.51, cy = size * 0.494;
    for (let i = 0; i < 260; i++) {
      const a0 = rand() * Math.PI * 2, len = 0.05 + rand() * 0.35;
      ctx.strokeStyle = `rgba(255,255,255,${(0.02 + rand() * 0.06) * wear})`;
      ctx.lineWidth = size * (0.002 + rand() * 0.006);
      ctx.beginPath(); ctx.arc(cx, cy, rf + (rand() - 0.5) * size * 0.006, a0, a0 + len); ctx.stroke();
    }
    // edge & corner wear
    for (let i = 0; i < 2600 * wear; i++) {
      const edge = Math.floor(rand() * 4), t = rand();
      const corner = Math.pow(Math.max(0, Math.abs(t - 0.5) * 2 - 0.7) / 0.3, 2);
      const depth = size * (0.0015 + Math.pow(rand(), 3) * 0.01 * (1 + corner * 4));
      const len = size * (0.002 + rand() * 0.02);
      ctx.fillStyle = `rgba(255,255,255,${(0.08 + rand() * 0.35) * wear})`;
      const p = t * size;
      if (edge === 0) ctx.fillRect(p, 0, len, depth);
      else if (edge === 1) ctx.fillRect(p, size - depth, len, depth);
      else if (edge === 2) ctx.fillRect(0, p, depth, len);
      else ctx.fillRect(size - depth, p, depth, len);
    }
    // faint scuffs
    ctx.lineCap = 'round';
    for (let i = 0; i < 14 * wear; i++) {
      const x = rand() * size, y = rand() * size, a = rand() * Math.PI, l = size * (0.01 + rand() * 0.04);
      ctx.strokeStyle = `rgba(255,255,255,${(0.03 + rand() * 0.05) * wear})`;
      ctx.lineWidth = 0.8 + rand() * 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  return c;
}
