import * as THREE from 'three';
import { R, makeDustMap, makeLabelBump, makeBoardSurface, composeArtwork } from './textures.js';

export const SLEEVE = { w: 31.4, t: 0.35 };
export const INSERT = { w: 30.5, t: 0.03 };
export const VINYL = { r: R, half: 0.085, labelR: 5.0, hole: 0.36 };

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

    const labelGeo = new THREE.RingGeometry(VINYL.hole, VINYL.labelR, 128, 1);
    const labelBump = makeLabelBump();
    const labelMat = () => new THREE.MeshPhysicalMaterial({
      roughness: 0.58, color: 0xffffff, bumpMap: labelBump, bumpScale: 0.6,
      sheen: 0.3, sheenRoughness: 0.7, sheenColor: 0xffffff,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    });
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
  makeTex(img, seed) {
    const t = new THREE.CanvasTexture(composeArtwork(img, this.wear, seed));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.opts.maxAniso;
    return t;
  }
  setArt(side, img) {
    this.images[side] = img;
    const m = side === 'front' ? this.front : this.back;
    m.map?.dispose();
    m.map = img ? this.makeTex(img, side === 'front' ? 1 : 2) : null;
    m.needsUpdate = true;
  }
  setWear(v) {
    this.wear = v;
    for (const side of ['front', 'back']) if (this.images[side]) this.setArt(side, this.images[side]);
  }
  setEdge(color) { this.edge.color.set(color); }
  setFinish(finish) {
    for (const m of [this.front, this.back]) {
      if (finish === 'gloss') { m.roughness = 0.3; m.clearcoat = 0.7; m.clearcoatRoughness = 0.08; m.bumpScale = 0.15; m.sheen = 0; }
      else if (finish === 'satin') { m.roughness = 0.55; m.clearcoat = 0.25; m.clearcoatRoughness = 0.35; m.bumpScale = 0.3; m.sheen = 0.15; }
      else { m.roughness = 0.82; m.clearcoat = 0; m.bumpScale = 0.5; m.sheen = 0.35; }
      m.needsUpdate = true;
    }
  }
}

export class Sleeve extends Card {
  constructor(opts) { super(SLEEVE.w, SLEEVE.t, { radius: 0.1, ...opts }); }
}
export class Insert extends Card {
  constructor(opts) { super(INSERT.w, INSERT.t, { radius: 0.012, ...opts }); }
}
