import * as THREE from 'three';
import { R, makeDustMap, makeLabelBump, makeBoardSurface, composeArtwork, makeVarnishMaps, makeShrinkWrapMaps, makeHoleMask } from './textures.js';

export const SLEEVE = { w: 31.4, t: 0.35 };
export const INSERT = { w: 30.5, t: 0.03 };
export const VINYL = { r: R, half: 0.085, labelR: 5.0, hole: 0.36 };
// die-cut sleeve: a 9.5 cm window onto the 10 cm label
export const DIECUT = { r: 4.75 };

// ---------- Vinyl ----------
function discGeometry() {
  // cross-section profile (r, y) of the top half, inner -> outer
  const top = [
    [0.36, 0.07], [0.38, 0.078], [0.42, 0.08], [5.1, 0.08], [5.16, 0.08],
    [5.24, 0.072], [5.3, 0.065], [5.36, 0.065], [14.64, 0.065], [14.7, 0.066],
    [14.76, 0.078], [14.82, 0.085], [14.88, 0.085], [14.94, 0.074], [14.98, 0.05], [15.0, 0.02],
  ];
  const pts = [];
  top.forEach(([r, y]) => pts.push(new THREE.Vector2(r, -y)));
  pts.push(new THREE.Vector2(15.0, 0.0));
  [...top].reverse().forEach(([r, y]) => pts.push(new THREE.Vector2(r, y)));
  pts.push(new THREE.Vector2(0.36, 0.0));
  pts.push(new THREE.Vector2(0.36, -0.07));
  const g = new THREE.LatheGeometry(pts, 256);
  // planar UVs (top view) so disc textures & radial maps line up
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z) || 1;
    // hole wall & rim: sample smooth vinyl instead of stretching the groove maps
    const k = r < 0.45 ? 5.6 / r : r > 14.9 ? 14.62 / r : 1;
    x *= k; z *= k;
    uv.setXY(i, x / (2 * R) + 0.5, 0.5 - z / (2 * R));
  }
  uv.needsUpdate = true;
  return g;
}

export class Vinyl {
  constructor(maps) {
    this.maps = maps;
    this.group = new THREE.Group(); // placement
    this.flip = new THREE.Group(); // side A / B
    this.spin = new THREE.Group(); // rotation around the spindle
    this.group.add(this.flip);
    this.flip.add(this.spin);

    this.material = new THREE.MeshPhysicalMaterial({
      color: 0x0a0a0a,
      roughness: 1,
      roughnessMap: maps.surface,
      bumpMap: maps.surface,
      bumpScale: 0.6,
      anisotropy: 0.85,
      anisotropyMap: maps.aniso,
      ior: 1.54,
      specularIntensity: 1,
    });
    this.disc = new THREE.Mesh(discGeometry(), this.material);
    this.disc.castShadow = this.disc.receiveShadow = true;
    this.spin.add(this.disc);

    const labelGeo = labelGeometry();
    this.labelA = new THREE.Mesh(labelGeo, labelMat());
    this.labelA.rotation.x = -Math.PI / 2;
    this.labelA.position.y = 0.082;
    this.labelB = new THREE.Mesh(labelGeo, labelMat());
    // same "up" as side A so the label reads upright when the record is turned around its vertical axis
    this.labelB.rotation.set(Math.PI / 2, 0, Math.PI);
    this.labelB.position.y = -0.082;
    this.labelA.receiveShadow = this.labelB.receiveShadow = true;
    this.spin.add(this.labelA, this.labelB);

    // dust & lint sitting on both faces
    const dustGeo = new THREE.RingGeometry(VINYL.hole + 0.02, R - 0.03, 256, 1);
    this.dustMat = new THREE.MeshStandardMaterial({
      color: 0xd9d4cb, roughness: 0.95, alphaMap: makeDustMap(), transparent: true, depthWrite: false, opacity: 0.6,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
    });
    this.dustA = new THREE.Mesh(dustGeo, this.dustMat);
    this.dustA.rotation.x = -Math.PI / 2;
    this.dustA.position.y = 0.0865;
    this.dustB = new THREE.Mesh(dustGeo, this.dustMat);
    this.dustB.rotation.x = Math.PI / 2;
    this.dustB.rotation.z = 1.3;
    this.dustB.position.y = -0.0865;
    this.dustA.renderOrder = this.dustB.renderOrder = 3;
    this.spin.add(this.dustA, this.dustB);
  }

  // Hide the part of the record that is inside a sleeve (it would otherwise poke through a warped board).
  setClip(plane) {
    const planes = plane ? [plane] : null;
    for (const m of [this.material, this.labelA.material, this.labelB.material, this.dustMat]) {
      m.clippingPlanes = planes;
      m.clipShadows = true;
      m.needsUpdate = true;
    }
  }

  setDust(v) {
    this.dustMat.opacity = v;
    this.dustA.visible = this.dustB.visible = v > 0.001;
  }

  setLabels(texA, texB) {
    this.labelA.material.map = texA; this.labelA.material.needsUpdate = true;
    this.labelB.material.map = texB; this.labelB.material.needsUpdate = true;
  }

  setSide(side) {
    this.flip.rotation.z = side === 'B' ? Math.PI : 0;
  }

  // style: { mode, color, tint, map }
  setStyle({ mode, color, tint, map, opacity = 1 }) {
    const m = this.material;
    m.map = null;
    m.transmission = 0;
    m.thickness = 0;
    m.transparent = false;
    m.roughness = 1;
    m.anisotropy = 0.85;
    m.bumpScale = 0.6;
    m.attenuationDistance = Infinity;
    m.attenuationColor.set(0xffffff);
    m.sheen = 0;
    switch (mode) {
      case 'clear':
        m.color.set(tint);
        m.transmission = 1;
        m.thickness = 0.17;
        m.roughness = 0.3;
        m.attenuationColor.set(tint);
        m.attenuationDistance = 0.6;
        m.bumpScale = 0.25;
        m.anisotropy = 0.6;
        break;
      case 'texture':
        m.color.set(0xffffff);
        m.map = map;
        if (opacity < 1) {
          // translucent coloured pressings (e.g. marble on clear)
          m.transmission = 1 - opacity;
          m.thickness = 0.17;
        }
        break;
      default:
        m.color.set(color);
    }
    m.needsUpdate = true;
  }
}

let labelGeo = null, labelBump = null;
function labelGeometry() { return (labelGeo ||= new THREE.RingGeometry(VINYL.hole, VINYL.labelR, 128, 1)); }
function labelMat() {
  labelBump ||= makeLabelBump();
  return new THREE.MeshPhysicalMaterial({
    roughness: 0.58, color: 0xffffff, bumpMap: labelBump, bumpScale: 0.6,
    sheen: 0.3, sheenRoughness: 0.7, sheenColor: 0xffffff,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
}

// ---------- Sleeve & insert ----------
// Axis coordinates for a rounded box: dense near the edges, sparse in the middle.
function axisCoords(L, r, steps = 4, mid = 24) {
  const h = L / 2, inner = h - r;
  const edge = Array.from({ length: steps + 1 }, (_, k) => r * Math.tan((k / steps) * (Math.PI / 4)));
  const out = [];
  for (let k = steps; k >= 0; k--) out.push(-inner - edge[k]);
  for (let i = 1; i < mid; i++) out.push(-inner + (2 * inner * i) / mid);
  for (let k = 0; k <= steps; k++) out.push(inner + edge[k]);
  return out;
}

// Rounded, slightly warped board. warpDir = +1 bows corners toward the front, -1 toward the back.
function boardGeometry(w, t, r, warp, warpDir) {
  const ax = axisCoords(w, r, 4, 28), az = axisCoords(t, Math.min(r, t / 2 - 0.01), 4, 1);
  const g = new THREE.BoxGeometry(1, 1, 1, ax.length - 1, ax.length - 1, az.length - 1);
  const pos = g.attributes.position, uv = g.attributes.uv;
  const hw = w / 2 - r, ht = t / 2 - Math.min(r, t / 2 - 0.01), rt = Math.min(r, t / 2 - 0.01);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ix = Math.round((pos.getX(i) + 0.5) * (ax.length - 1));
    const iy = Math.round((pos.getY(i) + 0.5) * (ax.length - 1));
    const iz = Math.round((pos.getZ(i) + 0.5) * (az.length - 1));
    p.set(ax[ix], ax[iy], az[iz]);
    // front/back faces: UVs follow the real (non-uniform) vertex positions so the artwork maps 1:1 onto the face
    const face = pos.getZ(i);
    if (face > 0.49) uv.setXY(i, p.x / w + 0.5, p.y / w + 0.5);
    else if (face < -0.49) uv.setXY(i, 0.5 - p.x / w, p.y / w + 0.5);
    // round the edges: push from the inner box outwards
    q.set(THREE.MathUtils.clamp(p.x, -hw, hw), THREE.MathUtils.clamp(p.y, -hw, hw), THREE.MathUtils.clamp(p.z, -ht, ht));
    const d = p.clone().sub(q);
    if (d.lengthSq() > 1e-10) {
      // ellipsoidal rounding: radius r in-plane, rt through the thickness
      d.set(d.x / r, d.y / r, d.z / rt).normalize();
      p.set(q.x + d.x * r, q.y + d.y * r, q.z + d.z * rt);
    }
    // warp: gentle bowl lifting the corners + a little twist
    const nx = p.x / (w / 2), ny = p.y / (w / 2);
    // mostly the corners curl; edge midpoints (where the record slides out) stay nearly flat. Max lift = warp.
    p.z += warpDir * warp * (0.85 * (nx * nx * ny * ny) + 0.15 * ny * ny * Math.abs(nx));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

function paperMaterial(opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.8,
    sheen: 0.35,
    sheenRoughness: 0.8,
    sheenColor: 0xffffff,
    ...opts,
  });
}

let boardSurface = null;
class Card {
  constructor(w, t, opts) {
    boardSurface ||= makeBoardSurface();
    this.opts = opts; // { maxAniso, radius }
    this.front = paperMaterial({ bumpMap: boardSurface, roughnessMap: boardSurface, bumpScale: 0.5 });
    this.back = paperMaterial({ bumpMap: boardSurface, roughnessMap: boardSurface, bumpScale: 0.5 });
    this.edge = paperMaterial({ roughness: 0.9, color: 0xf2f0ec, bumpMap: boardSurface, bumpScale: 1 });
    this.w = w; this.t = t;
    this.warp = 0; this.wear = 0.4; this.images = {};
    this.finish = 'matte';
    this.varnish = { on: true, strength: 1, maps: {} };
    this.geo = {};
    this.buildGeometry();
    this.mesh = new THREE.Mesh(this.geo.front, [this.edge, this.edge, this.edge, this.edge, this.front, this.back]);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.clones = [];
  }
  buildGeometry() {
    const r = this.opts.radius;
    Object.values(this.geo).forEach((g) => g.dispose());
    this.geo = {
      front: boardGeometry(this.w, this.t, r, this.warp, 1),
      back: boardGeometry(this.w, this.t, r, this.warp, -1),
    };
  }
  clone() {
    const m = this.mesh.clone();
    m.castShadow = m.receiveShadow = true;
    this.clones.push(m);
    return m;
  }
  // which face lies up decides which way the corners curl
  orient(mesh, faceUp) { mesh.geometry = faceUp === 'back' ? this.geo.back : this.geo.front; }
  setWarp(v) {
    this.warp = v;
    const meshes = [this.mesh, ...this.clones];
    const faces = meshes.map((m) => (m.geometry === this.geo.back ? 'back' : 'front'));
    this.buildGeometry();
    meshes.forEach((m, i) => this.orient(m, faces[i]));
  }
  makeTex(img, seed, varnish) {
    const t = new THREE.CanvasTexture(composeArtwork(img, this.wear, seed, 2048, varnish));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.opts.maxAniso;
    return t;
  }
  setArt(side, img) {
    this.images[side] = img;
    const m = side === 'front' ? this.front : this.back;
    m.map?.dispose();
    const v = this.varnish.on ? this.varnish.maps[side] : null;
    m.map = img ? this.makeTex(img, side === 'front' ? 1 : 2, v) : null;
    m.needsUpdate = true;
  }
  setWear(v) {
    this.wear = v;
    for (const side of ['front', 'back']) if (this.images[side]) this.setArt(side, this.images[side]);
  }
  setEdge(color) { this.edge.color.set(color); }
  setFinish(finish) {
    this.finish = finish;
    this.applySurface();
  }
  // Spot (selective) varnish: a glossy transparent layer on the masked areas only.
  setVarnishMask(side, img) {
    const old = this.varnish.maps[side];
    old && [old.mask, old.normal, old.surface].forEach((t) => t && t.dispose());
    this.varnish.maps[side] = img ? makeVarnishMaps(img, 2048, boardSurface.image) : null;
    if (this.images[side]) this.setArt(side, this.images[side]);
    this.applySurface();
  }
  setVarnish({ on = this.varnish.on, strength = this.varnish.strength } = {}) {
    const changed = on !== this.varnish.on;
    Object.assign(this.varnish, { on, strength });
    if (changed) for (const side of ['front', 'back']) if (this.images[side]) this.setArt(side, this.images[side]);
    this.applySurface();
  }
  applySurface() {
    for (const [side, m] of [['front', this.front], ['back', this.back]]) {
      const f = this.finish;
      if (f === 'gloss') { m.roughness = 0.3; m.clearcoat = 0.7; m.clearcoatRoughness = 0.08; m.bumpScale = 0.15; m.sheen = 0; }
      else if (f === 'satin') { m.roughness = 0.55; m.clearcoat = 0.25; m.clearcoatRoughness = 0.35; m.bumpScale = 0.3; m.sheen = 0.15; }
      else { m.roughness = 0.82; m.clearcoat = 0; m.bumpScale = 0.5; m.sheen = 0.35; }
      m.clearcoatMap = null;
      m.clearcoatNormalMap = null;
      // die-cut window (sleeve only): the board is cut away inside the circle
      const hole = this.dieCut ? this.holeMask : null;
      m.alphaMap = hole;
      m.alphaTest = hole ? 0.5 : 0;
      m.bumpMap = m.roughnessMap = boardSurface;
      const v = this.varnish.maps[side];
      if (v && this.varnish.on && f !== 'gloss') {
        // varnish sits on top of the board: its own smooth normal (only the raised edges), mirror-like
        m.clearcoat = this.varnish.strength;
        m.clearcoatMap = v.mask;
        m.clearcoatRoughness = 0.05;
        m.clearcoatNormalMap = v.normal;
        m.clearcoatNormalScale.set(1, 1);
        // the raised layer also shapes the paper shading underneath (visible under any light)
        if (v.surface) { m.bumpMap = m.roughnessMap = v.surface; m.bumpScale = f === 'satin' ? 0.55 : 0.8; }
      }
      m.needsUpdate = true;
    }
  }
}

// Shrink wrap and the die-cut window live as children of the board, so clones of the sleeve carry them too.
const WRAP_GAP = 0.02; // film standing off the board (cm)
export class Sleeve extends Card {
  constructor(opts) {
    super(SLEEVE.w, SLEEVE.t, { radius: 0.1, ...opts });
    this.shrink = false;
    this.dieCut = false;

    // shrink wrap: a thin clear film (transmissive, so its reflections stay at full strength) with creases & haze
    // (its maps are generated the first time it's switched on)
    this.wrapMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 1, transmission: 1, thickness: 0, ior: 1.5,
      // a physical 4% film mirrors the whole softbox as a flat grey veil over the artwork; toned down, the
      // reflections read as streaks along the creases instead
      specularIntensity: 0.5,
    });
    const wrap = new THREE.Mesh(this.geo.wrapFront, this.wrapMat);
    wrap.name = 'wrap';
    wrap.receiveShadow = true; // a clear film casts (almost) no shadow
    wrap.visible = false;
    this.mesh.add(wrap);

    // die-cut window: the cut wall of the board, and the record inside it (seen through the hole)
    const hole = new THREE.Group();
    hole.name = 'hole';
    hole.visible = false;
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(DIECUT.r, DIECUT.r, SLEEVE.t, 128, 1, true).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xe6e1d8, roughness: 0.92, side: THREE.BackSide }),
    );
    wall.receiveShadow = true;
    hole.add(wall);
    const inner = new THREE.Group();
    inner.name = 'record';
    this.labelA = new THREE.Mesh(labelGeometry(), labelMat());
    this.labelA.position.z = VINYL.half;
    this.labelB = new THREE.Mesh(labelGeometry(), labelMat());
    this.labelB.rotation.y = Math.PI;
    this.labelB.position.z = -VINYL.half;
    for (const l of [this.labelA, this.labelB]) {
      l.castShadow = l.receiveShadow = true; // no light leaking through the hole
      l.material.polygonOffset = false; // sits well below the board: an offset would pull it through the face
    }
    inner.add(this.labelA, this.labelB);
    hole.add(inner);
    // when the real vinyl sits in this sleeve, the patch of it seen through the window (the vinyl itself is clipped
    // away inside the sleeve so it can't poke through a warped board)
    this.discMat = new THREE.MeshPhysicalMaterial();
    const patch = new THREE.Mesh(new THREE.BufferGeometry(), this.discMat);
    patch.name = 'patch';
    patch.receiveShadow = true;
    patch.visible = false;
    hole.add(patch);
    this.mesh.add(hole);
  }
  buildGeometry() {
    super.buildGeometry();
    const r = this.opts.radius + WRAP_GAP, w = this.w + 2 * WRAP_GAP, t = this.t + 2 * WRAP_GAP;
    this.geo.wrapFront = boardGeometry(w, t, r, this.warp, 1);
    this.geo.wrapBack = boardGeometry(w, t, r, this.warp, -1);
  }
  orient(mesh, faceUp) {
    super.orient(mesh, faceUp);
    const wrap = mesh.getObjectByName('wrap');
    if (wrap) wrap.geometry = faceUp === 'back' ? this.geo.wrapBack : this.geo.wrapFront;
  }
  get meshes() { return [this.mesh, ...this.clones]; }
  setShrink(on) {
    this.shrink = on;
    const m = this.wrapMat;
    if (on && !m.normalMap) {
      const wm = makeShrinkWrapMaps();
      Object.assign(m, { normalMap: wm.normal, roughnessMap: wm.surface, transmissionMap: wm.surface });
      m.needsUpdate = true;
    }
    this.meshes.forEach((m) => (m.getObjectByName('wrap').visible = on));
  }
  setDieCut(on) {
    this.dieCut = on;
    this.holeMask ||= makeHoleMask(DIECUT.r / this.w);
    this.meshes.forEach((m) => (m.getObjectByName('hole').visible = on));
    this.applySurface();
  }
  syncDiscMaterial(vinylMat) {
    this.discMat.copy(vinylMat);
    this.discMat.clippingPlanes = null;
    this.discMat.needsUpdate = true;
  }
  // What the die-cut window shows: a record centred in the sleeve, or (vinyl = the Vinyl sliding out of this
  // sleeve) that very record, wherever it is and however it's spun or flipped.
  syncRecord(mesh, vinyl = null) {
    const rec = mesh.getObjectByName('record'), patch = mesh.getObjectByName('patch');
    rec.position.set(0, 0, 0);
    rec.quaternion.identity();
    rec.visible = true;
    patch.visible = false;
    if (!this.dieCut || !vinyl) return;
    mesh.updateWorldMatrix(true, false);
    vinyl.labelA.updateWorldMatrix(true, false);
    const toLocal = mesh.matrixWorld.clone().invert();
    const m = toLocal.clone().multiply(vinyl.labelA.matrixWorld);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    m.decompose(pos, q, sc);
    rec.position.set(pos.x, pos.y, 0);
    rec.quaternion.copy(q);
    const d = Math.hypot(pos.x, pos.y);
    // only whole labels: one that reaches the opening is out of reach of the window anyway
    rec.visible = d + VINYL.labelR < this.w / 2 - 0.05;
    // the part of the disc inside the window: hole circle ∩ disc circle, minus the spindle hole
    const r1 = DIECUT.r + 0.02, pts = [];
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2, x = Math.cos(a) * r1, y = Math.sin(a) * r1;
      if (Math.hypot(x - pos.x, y - pos.y) <= R) pts.push(new THREE.Vector2(x, y));
    }
    for (let i = 0; i < 256; i++) {
      const a = (i / 256) * Math.PI * 2, x = pos.x + Math.cos(a) * R, y = pos.y + Math.sin(a) * R;
      if (Math.hypot(x, y) < r1) pts.push(new THREE.Vector2(x, y));
    }
    if (pts.length < 3) return;
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector2()).divideScalar(pts.length);
    pts.sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
    const shape = new THREE.Shape(pts);
    if (d + VINYL.hole < r1) shape.holes.push(new THREE.Path().absarc(pos.x, pos.y, VINYL.hole, 0, Math.PI * 2, true));
    const flat = new THREE.ShapeGeometry(shape, 8);
    const fp = flat.attributes.position, idx = flat.index.array;
    // both faces (front at +z, back at -z, facing out), UVs = the disc's own planar UVs at that point
    vinyl.disc.updateWorldMatrix(true, false);
    const toDisc = vinyl.disc.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
    const zf = 0.066, P = [], N = [], U = [], I = [], v = new THREE.Vector3();
    for (const side of [1, -1]) {
      const base = P.length / 3;
      for (let i = 0; i < fp.count; i++) {
        v.set(fp.getX(i), fp.getY(i), side * zf);
        P.push(v.x, v.y, v.z);
        N.push(0, 0, side);
        v.applyMatrix4(toDisc);
        U.push(v.x / (2 * R) + 0.5, 0.5 - v.z / (2 * R));
      }
      for (let i = 0; i < idx.length; i += 3) {
        if (side > 0) I.push(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
        else I.push(base + idx[i], base + idx[i + 2], base + idx[i + 1]);
      }
    }
    flat.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    patch.geometry.dispose();
    patch.geometry = g;
    patch.visible = true;
  }
  setLabels(texA, texB) {
    this.labelA.material.map = texA; this.labelA.material.needsUpdate = true;
    this.labelB.material.map = texB; this.labelB.material.needsUpdate = true;
  }
}
export class Insert extends Card {
  constructor(opts) { super(INSERT.w, INSERT.t, { radius: 0.012, ...opts }); }
}
