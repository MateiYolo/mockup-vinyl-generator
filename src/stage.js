import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { makeBackdropMaps } from './textures.js';

const DEG = Math.PI / 180;
// sky samples live between these heights (sin of elevation). Capped below the zenith: a light straight overhead
// makes the shadow camera's lookAt degenerate (NaN), and one NaN sample poisons the running average for good.
const SKY_MIN = Math.sin(18 * DEG), SKY_MAX = 0.97;
// share of the backdrop's brightness that doesn't depend on the lights (bounce from the rest of the studio)
const BACKDROP_SELF = 0.12;
// Diffuse image-based light is never shadowed, and it used to carry most of the ambient light: everything looked flat.
// Only a little of it is kept; the rest moves to the shadow-casting sky samples (real occlusion, see skyGain).
// The environment still drives all the reflections.
const IBL_DIFFUSE = 0.3;
THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps.replace(
  'iblIrradiance += getIBLIrradiance( geometryNormal );',
  `iblIrradiance += getIBLIrradiance( geometryNormal ) * ${IBL_DIFFUSE.toFixed(2)};`,
);
// share of that removed ambient handed to the sky; the key is stronger instead -> a ~2:1 key-to-fill ratio
const AMBIENT_TO_SKY = 0.35;

const quad = (frag, uniforms) => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: frag,
}));

// Soft grounding shadow rendered from below (adapted from three.js contact shadow example)
class ContactShadow {
  constructor(renderer) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.position.y = 0.02;
    this.rt = new THREE.WebGLRenderTarget(1024, 1024);
    this.rt.texture.generateMipmaps = false;
    this.rtBlur = new THREE.WebGLRenderTarget(1024, 1024);
    this.rtBlur.texture.generateMipmaps = false;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
    this.plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this.rt.texture, transparent: true, depthWrite: false, opacity: 0.6,
    }));
    this.plane.renderOrder = 1;
    this.plane.scale.y = -1;
    this.group.add(this.plane);
    this.blurPlane = new THREE.Mesh(geo);
    this.blurPlane.visible = false;
    this.group.add(this.blurPlane);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 3);
    this.camera.rotation.x = Math.PI / 2;
    this.group.add(this.camera);

    this.depthMat = new THREE.MeshDepthMaterial();
    this.depthMat.userData.darkness = { value: 1.8 };
    this.depthMat.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depthMat.userData.darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 1.0 ), ( 1.0 - fragCoordZ ) * darkness );',
      )}`;
    };
    this.depthMat.depthTest = false;
    this.depthMat.depthWrite = false;
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.hBlur.depthTest = false;
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.vBlur.depthTest = false;
    this.blur = 3.2;
  }
  fit(box) {
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const s = Math.max(size.x, size.z) * 2.2 + 20;
    this.group.position.x = c.x;
    this.group.position.z = c.z;
    this.plane.scale.set(s, -1, s);
    Object.assign(this.camera, { left: -s / 2, right: s / 2, top: s / 2, bottom: -s / 2, far: 3.5 + (this.lift || 0) * 1.6 });
    this.camera.updateProjectionMatrix();
    this.s = s;
  }
  blurPass(amount) {
    const r = this.renderer;
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    r.setRenderTarget(this.rtBlur);
    r.render(this.blurPlane, this.camera);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    r.setRenderTarget(this.rt);
    r.render(this.blurPlane, this.camera);
    this.blurPlane.visible = false;
  }
  update(scene, hide = []) {
    const r = this.renderer;
    const bg = scene.background;
    scene.background = null;
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    this.plane.visible = false;
    scene.overrideMaterial = this.depthMat;
    const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
    r.setClearColor(0xffffff, 0); // white rgb, so the plane's colour decides the shadow tint
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, this.camera);
    scene.overrideMaterial = null;
    this.blurPass(this.blur);
    this.blurPass(this.blur * 0.4);
    r.setRenderTarget(null);
    r.setClearColor(clearColor, clearAlpha);
    scene.background = bg;
    hide.forEach((o, i) => (o.visible = vis[i]));
    this.plane.visible = true;
  }
}

// Photo studio used for reflections and image-based light: a room tinted by the backdrop, a big key softbox,
// an overhead box, a rim strip and a fill card. Light sources are diffusers with a hot centre and a soft rim
// (not flat quads), so glossy surfaces show believable softbox reflections.
const softRectValue = (u, v) => {
  const x = u * 2 - 1, y = v * 2 - 1;
  const e = Math.pow(Math.pow(Math.abs(x), 6) + Math.pow(Math.abs(y), 6), 1 / 6); // rounded rectangle
  const s = Math.min(1, Math.max(0, (1 - e) / 0.16));
  return (1 - 0.3 * e * e) * s * s * (3 - 2 * s);
};
let softRectTex = null;
function softRect() {
  if (softRectTex) return softRectTex;
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4, v = softRectValue((x + 0.5) / S, (y + 0.5) / S) * 255;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  softRectTex = new THREE.CanvasTexture(c);
  return softRectTex;
}

let softboxTex = null;
function softbox() {
  if (softboxTex) return softboxTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, '#fff'); g.addColorStop(0.55, '#fff'); g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  softboxTex = new THREE.CanvasTexture(c);
  return softboxTex;
}

// glints: [{ dir: Vector3 (env space), intensity }] soft reflectors placed where the camera sees their mirror image
// bg: backdrop colour (linear). The room and its floor take its tone, so reflections and bounce match the set.
function studioEnvironment(glints = [], bg = new THREE.Color(0.6, 0.55, 0.52)) {
  const scene = new THREE.Scene();
  // walls: darker near the floor, a little brighter towards the ceiling
  const wall = bg.clone().multiplyScalar(0.12).addScalar(0.012);
  const roomGeo = new THREE.BoxGeometry(120, 80, 120, 1, 8, 1);
  const wallShade = (y) => 0.55 + 0.9 * THREE.MathUtils.clamp((y + 40) / 80, 0, 1);
  const cols = [];
  const pos = roomGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) { const k = wallShade(pos.getY(i)); cols.push(wall.r * k, wall.g * k, wall.b * k); }
  roomGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const room = new THREE.Mesh(roomGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  room.position.y = 25;
  room.userData.shade = (hit) => wall.clone().multiplyScalar(wallShade(hit.point.y - 25));
  scene.add(room);
  const floorCol = bg.clone().multiplyScalar(0.45);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: floorCol }));
  floor.position.y = -14;
  floor.userData.shade = () => floorCol;
  scene.add(floor);
  const panel = (w, h, az, el, dist, intensity) => {
    const col = new THREE.Color(intensity, intensity, intensity);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: col, map: softRect(), side: THREE.DoubleSide }));
    m.position.set(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG)).multiplyScalar(dist);
    m.lookAt(0, 0, 0);
    m.userData.shade = (hit) => col.clone().multiplyScalar(softRectValue(hit.uv.x, hit.uv.y));
    scene.add(m);
  };
  panel(38, 50, 225, 38, 40, 11); // key softbox (follows the key light via environmentRotation)
  panel(60, 60, 0, 88, 38, 1.6); // overhead
  panel(9, 52, 60, 18, 42, 6); // rim strip
  panel(46, 40, -30, 10, 44, 2.6); // white fill card behind the camera
  panel(14, 20, 150, 55, 45, 1.2); // small kicker, breaks the symmetry of the reflections
  for (const { dir, intensity } of glints) {
    // long, soft strip softbox, tilted: its mirror image sweeps a diagonal band across the cover
    const m = new THREE.Mesh(new THREE.PlaneGeometry(80, 7), new THREE.MeshBasicMaterial({
      map: softbox(), color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    m.position.copy(dir).normalize().multiplyScalar(36);
    m.lookAt(0, 0, 0);
    m.rotateZ(0.45);
    scene.add(m);
  }
  return scene;
}

// Cosine-weighted average radiance of the studio seen by an up-facing surface (what the IBL adds to the floor).
function envRadianceUp(scene) {
  scene.updateMatrixWorld(true);
  const shaded = scene.children.filter((m) => m.userData.shade);
  const rc = new THREE.Raycaster(), o = new THREE.Vector3(), d = new THREE.Vector3(), sum = new THREE.Color();
  const N = 256;
  for (let i = 1; i <= N; i++) {
    const u = halton(i, 2), r = Math.sqrt(u), ph = halton(i, 3) * Math.PI * 2;
    d.set(Math.cos(ph) * r, Math.sqrt(1 - u), Math.sin(ph) * r);
    rc.set(o, d);
    const hit = rc.intersectObjects(shaded, false)[0];
    if (hit) sum.add(hit.object.userData.shade(hit));
  }
  return sum.multiplyScalar(1 / N);
}

// Seamless paper sweep: a floor that curves up into a wall behind the set. It is lit like the objects, so it
// shows the key's falloff, takes tinted shadows and bounces its colour back. Built in local space with the
// camera looking towards -z; the stage turns it to face the camera.
function sweepGeometry(back, radius) {
  const W = 6000, F = 3000, H = 3000;
  const prof = [[F, 0], [-back, 0]];
  for (let k = 1; k <= 16; k++) {
    const a = (k / 16) * (Math.PI / 2);
    prof.push([-back - Math.sin(a) * radius, radius - Math.cos(a) * radius]);
  }
  prof.push([-back - radius, H]);
  const pos = [], uv = [], idx = [];
  let s = 0;
  prof.forEach(([z, y], i) => {
    if (i) s += Math.hypot(z - prof[i - 1][0], y - prof[i - 1][1]);
    pos.push(-W / 2, y, z, W / 2, y, z);
    uv.push(-W / 2 / 40, -s / 40, W / 2 / 40, -s / 40); // 40 cm per texture tile
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Glow around the brightest highlights (quarter resolution, warm tinted when composited: film halation).
class Bloom {
  constructor() {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.a = new THREE.WebGLRenderTarget(1, 1, opts);
    this.b = new THREE.WebGLRenderTarget(1, 1, opts);
    this.bright = quad(`uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
      // clamped: a few extremely hot specular pixels (not converged yet) would otherwise bloom into square blobs
      vec3 f(vec2 o){ vec3 c = texture2D(src, vUv + o * texel).rgb; float l = max(c.r, max(c.g, c.b)); return c / max(1.0, l / 2.5) * smoothstep(1.0, 2.2, l); }
      void main(){ gl_FragColor = vec4((f(vec2(-1.0)) + f(vec2(1.0, -1.0)) + f(vec2(-1.0, 1.0)) + f(vec2(1.0))) * 0.25, 1.0); }`,
    { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.blur = quad(`uniform sampler2D src; uniform vec2 dir; varying vec2 vUv;
      void main(){
        vec3 c = texture2D(src, vUv).rgb * 0.2270;
        c += (texture2D(src, vUv + dir * 1.3846).rgb + texture2D(src, vUv - dir * 1.3846).rgb) * 0.3162;
        c += (texture2D(src, vUv + dir * 3.2308).rgb + texture2D(src, vUv - dir * 3.2308).rgb) * 0.0703;
        gl_FragColor = vec4(c, 1.0);
      }`, { src: { value: null }, dir: { value: new THREE.Vector2() } });
  }
  run(r, src, w, h, cam) {
    const bw = Math.max(1, Math.round(w / 4)), bh = Math.max(1, Math.round(h / 4));
    if (this.a.width !== bw || this.a.height !== bh) { this.a.setSize(bw, bh); this.b.setSize(bw, bh); }
    const B = this.bright.material.uniforms;
    B.src.value = src; B.texel.value.set(1 / w, 1 / h);
    r.setRenderTarget(this.a); r.render(this.bright, cam);
    // radius proportional to the picture height, so previews and 4K exports glow alike
    const U = this.blur.material.uniforms, step = bh / 300;
    for (const k of [1, 2.5, 4]) {
      U.src.value = this.a.texture; U.dir.value.set((k * step) / bw, 0);
      r.setRenderTarget(this.b); r.render(this.blur, cam);
      U.src.value = this.b.texture; U.dir.value.set(0, (k * step) / bh);
      r.setRenderTarget(this.a); r.render(this.blur, cam);
    }
    return this.a.texture;
  }
}

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

function boxCorners(b) {
  return Array.from({ length: 8 }, (_, i) => new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
}

// White balance of a light: 0 = cool, 0.5 = neutral, 1 = warm (tungsten-ish). Same luminance whatever the tint.
function tempColor(t) {
  const c = new THREE.Color(1, 1, 1);
  if (t < 0.5) c.lerp(new THREE.Color(0.8, 0.9, 1.0), (0.5 - t) * 2);
  else c.lerp(new THREE.Color(1.0, 0.8, 0.6), (t - 0.5) * 2);
  return c.multiplyScalar(1 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = (this.scene = new THREE.Scene());
    this.pmrem = new THREE.PMREMGenerator(r);
    this.bg = new THREE.Color(0xd8cec7);
    this.glint = 0; // "varnish reflector" strength
    this.skyShadow = 1; // scales the sky-dome (ambient) floor shadow, faded while a layout floats
    this.glintKey = '';
    this.buildEnv();
    scene.environmentIntensity = 0.35;

    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI - 0.02; // allow looking from underneath
    this.controls.screenSpacePanning = true;

    // turntable pivot (centre of the layout) -> root (objects)
    this.turn = new THREE.Group();
    this.root = new THREE.Group();
    this.turn.add(this.root);
    scene.add(this.turn);

    // key: a softbox at a finite distance, sampled over its surface -> soft shadows plus inverse-square falloff
    const key = (this.key = new THREE.SpotLight(0xffffff, 1, 0, 1.3, 0.75, 2));
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    key.shadow.normalBias = 0.012;
    scene.add(key, key.target);
    // sky: directional samples over the dome -> ambient occlusion
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 1));
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.normalBias = 0.012;
    sun.target = key.target;
    sun.visible = false;
    scene.add(sun);

    this.fill = new THREE.HemisphereLight(0xffffff, 0xd8d0c8, 0.5);
    // light bounced off the backdrop onto whatever faces it (upright covers, edges, the disc rim)
    this.bounce = new THREE.HemisphereLight(0x000000, 0xffffff, 0);
    scene.add(this.fill, this.bounce);

    // transparent exports: shadows only, on an invisible floor
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.35, transparent: true, depthWrite: false }),
    );
    this.floor.receiveShadow = true;
    this.floor.renderOrder = 2;
    scene.add(this.floor);
    // everything else: a lit paper sweep
    const paper = makeBackdropMaps();
    paper.tone.repeat.set(0.3, 0.3);
    this.sweepMat = new THREE.MeshStandardMaterial({ roughness: 0.88, map: paper.tone, bumpMap: paper.bump, bumpScale: 0.3 });
    this.sweep = new THREE.Mesh(sweepGeometry(60, 70), this.sweepMat);
    this.sweep.receiveShadow = true;
    scene.add(this.sweep);

    this.contact = new ContactShadow(r);
    scene.add(this.contact.group);

    this.light = {
      az: 225, el: 42, softness: 0.6, strength: 0.3, ambient: 0.55, contact: 0.35, master: 0.5, env: 0.42, key: 3.3, sky: 0.95,
      falloff: 0.5, bounce: 0.5, warmth: 0.55, contrast: 0.4,
    };
    this.photo = { fstop: 5.6, grain: 0.35, vignette: 0.2, seed: 0, bloom: 0.35, ca: 0.3, look: 0.5 };
    this.view = { az: -22, el: 48, lens: 70, zoom: 1 };
    this.box = new THREE.Box3(new THREE.Vector3(-15, 0, -15), new THREE.Vector3(15, 1, 15));
    this.aspect = 1;
    this.onViewChange = null;
    this.controls.addEventListener('change', () => { this.syncViewFromCamera(); this.invalidate(false); });
    this.beforeRender = null;

    // progressive accumulation (soft area-light shadows + sub-pixel AA)
    // three accumulation buffers: low-res while interacting, full-res when idle, and one for exports
    const mk = (max) => ({ n: 0, max, w: 0, h: 0, msaa: 0 });
    this.accLo = mk(1); this.accHi = mk(160); this.accEx = mk(1e9);
    this.acc = this.accHi;
    this.lastInvalidate = 0;
    this.loScale = 0.5; // raised during loop previews for a sharper picture
    // running average; a NaN/inf sample (degenerate light, bad normal) is dropped instead of poisoning the pixel for good
    this.blendQuad = quad(`uniform sampler2D prev, cur; uniform float w; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(cur, vUv), p = texture2D(prev, vUv);
        bool bad = !(c.r == c.r && c.g == c.g && c.b == c.b && c.a == c.a) || max(max(c.r, c.g), max(c.b, c.a)) > 6.0e4;
        gl_FragColor = bad ? (w >= 1.0 ? vec4(0.0) : p) : mix(p, c, w);
      }`,
    { prev: { value: null }, cur: { value: null }, w: { value: 1 } });
    this.bloom = new Bloom();
    this.presentQuad = quad(`uniform sampler2D tDiffuse, tBloom, bgMap; uniform float grain, vignette, seed, bloom, ca, look, bgOn; uniform vec2 res, bgSize; varying vec2 vUv;
      float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031 + seed * .0137); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main(){
        vec2 d = vUv - 0.5, dc = d * vec2(res.x / res.y, 1.0);
        float r2 = dot(dc, dc);
        // lateral chromatic aberration: red focuses slightly wider than blue towards the corners
        vec2 off = d * r2 * ca * 0.008;
        vec4 c = texture2D(tDiffuse, vUv);
        c.r = texture2D(tDiffuse, vUv + off).r;
        c.b = texture2D(tDiffuse, vUv - off).b;
        // halation: warm glow bleeding around the brightest highlights
        c.rgb += texture2D(tBloom, vUv).rgb * bloom * vec3(1.0, 0.8, 0.66);
        gl_FragColor = c;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // photo / video backdrop, fitted like CSS "cover", composited under the (premultiplied) render in display space
        if (bgOn > 0.5) {
          float sa = res.x / res.y, ma = bgSize.x / bgSize.y;
          vec2 s = sa > ma ? vec2(1.0, ma / sa) : vec2(sa / ma, 1.0);
          vec3 bg = texture2D(bgMap, (vUv - 0.5) * s + 0.5).rgb;
          gl_FragColor = vec4(gl_FragColor.rgb + bg * (1.0 - gl_FragColor.a), 1.0);
        }
        float a = gl_FragColor.a;
        vec3 col = gl_FragColor.rgb;
        // print look: a touch of mid-tone contrast, lifted warm blacks, softened top end
        col = mix(col, col * col * (3.0 - 2.0 * col), 0.22 * look);
        col = col * (1.0 - 0.035 * look) + vec3(0.024, 0.021, 0.018) * look * a;
        // lens falloff
        col *= 1.0 - vignette * smoothstep(0.35, 1.0, length(dc));
        // film grain: clumped (two octaves of value noise), mostly luminance with a little chroma, strongest in the mid-tones
        vec2 gp = vUv * vec2(res.x / res.y, 1.0) * 1100.0;
        float g = (vnoise(gp) - 0.5) * 0.7 + (vnoise(gp * 2.13 + 17.0) - 0.5) * 0.5;
        vec3 gc = vec3(g) + 0.3 * vec3(vnoise(gp * 1.7 + 3.0) - 0.5, 0.0, vnoise(gp * 1.7 + 9.0) - 0.5);
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col += gc * grain * 0.2 * (0.3 + 0.7 * (1.0 - abs(lum * 2.0 - 1.0))) * a;
        // dither: no banding in the smooth backdrop gradients
        col += (hash(gl_FragCoord.xy + 3.1) + hash(gl_FragCoord.xy + 7.7) - 1.0) / 255.0 * a;
        gl_FragColor = vec4(col, a);
      }`, {
      tDiffuse: { value: null }, tBloom: { value: null }, grain: { value: 0 }, vignette: { value: 0 }, seed: { value: 0 },
      bloom: { value: 0 }, ca: { value: 0 }, look: { value: 0 }, res: { value: new THREE.Vector2(1, 1) },
      bgMap: { value: null }, bgOn: { value: 0 }, bgSize: { value: new THREE.Vector2(1, 1) },
    });
    this.presentQuad.material.toneMapped = true;
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // (Re)build the reflection studio: tinted by the backdrop, plus the varnish reflectors.
  buildEnv(glints = []) {
    const env = studioEnvironment(glints, this.bg);
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(env, 0.02);
    this.scene.environment = this.envRT.texture;
    old && old.dispose();
    this.envUp = envRadianceUp(env);
    this.calibrate();
  }

  // Pick the backdrop's albedo so that, unshadowed at the centre of the set, it renders exactly at the chosen
  // background colour. Away from the key it falls off, in shadow it darkens, and it takes the lights' tint on objects.
  calibrate() {
    if (!this.sweepMat || !this.light) return;
    const L = this.light, kc = this.key.color, sc = this.sun.color, u = this.envUp;
    const skyMean = (SKY_MIN + SKY_MAX) / 2, lum = 0.2126 * u.r + 0.7152 * u.g + 0.0722 * u.b;
    this.skyGain = 1 + (AMBIENT_TO_SKY * Math.PI * (1 - IBL_DIFFUSE) * L.env * lum) / Math.max(0.05, L.sky * skyMean);
    const e = L.env * IBL_DIFFUSE;
    const kE = L.key * Math.sin(L.el * DEG) / Math.PI, sE = L.sky * this.skyGain * skyMean / Math.PI;
    const g = [kE * kc.r + sE * sc.r + e * u.r, kE * kc.g + sE * sc.g + e * u.g, kE * kc.b + sE * sc.b + e * u.b];
    const bg = this.bg, S = BACKDROP_SELF;
    this.sweepMat.color.setRGB((bg.r * (1 - S)) / g[0], (bg.g * (1 - S)) / g[1], (bg.b * (1 - S)) / g[2]);
    this.sweepMat.emissive.setRGB(bg.r * S, bg.g * S, bg.b * S);
    // a surface facing an endless floor of this radiance receives pi * radiance * 1/2 at vertical incidence
    this.bounce.groundColor.copy(bg).multiplyScalar(Math.PI);
    this.fill.groundColor.copy(bg);
  }

  // sceneChanged=false for pure camera moves (contact shadow stays valid)
  invalidate(sceneChanged = true) {
    this.accLo.n = this.accHi.n = this.accEx.n = 0;
    if (sceneChanged) this.contactDirty = true;
    this.lastInvalidate = performance.now();
  }

  ensureTargets(w, h, msaa) {
    const a = this.acc;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (a.w === w && a.h === h && a.msaa === msaa && a.rtA) return;
    [a.rtA, a.rtB, a.sample].forEach((t) => t && t.dispose());
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    a.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    a.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    a.sample = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: msaa });
    Object.assign(a, { w, h, msaa, n: 0 });
  }

  // Render one stochastic sample and fold it into the running average.
  // n = 0 is a fast preview (key + unshadowed fill); n >= 1 alternates a point on the key softbox and a sky direction,
  // each casting shadows, which converges to soft area shadows + ambient occlusion. Camera jitter adds AA & depth of field.
  accumulate() {
    const r = this.renderer, a = this.acc, n = a.n, L = this.light, cam = this.camera;
    if (this.contactDirty) { this.contact.update(this.scene, [this.floor, this.sweep]); this.contactDirty = false; }
    const tgt = this.key.target.position;
    const d = this.lightDir.clone();
    const savedPos = cam.position.clone();
    const lit = !this.shadowOnly;
    // a floating object's sky shadow is too diffuse to resolve with a few dozen samples (it shows as stepped
    // ghost copies): fade it with the height instead
    const skyFade = this.skyShadow / (1 + (this.lift || 0) / 3);
    let keyPos = null;
    this.fill.intensity = 0;
    if (n === 0) {
      keyPos = tgt.clone().addScaledVector(d, this.keyDist);
      this.key.intensity = L.key * this.keyDist ** 2;
      this.fill.intensity = L.sky * this.skyGain * 0.45;
      this.floor.material.opacity = Math.min(1, L.strength * this.shadowMul());
    } else {
      const i = n - 1, j = Math.floor(i / 2) + 1;
      if (i % 2 === 0) {
        // a point on the softbox (a disc facing the set)
        const rad = Math.sqrt(halton(j, 2)) * this.keyRadius, th = halton(j, 3) * Math.PI * 2;
        const t1 = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
        if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
        t1.normalize();
        const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
        keyPos = tgt.clone().addScaledVector(d, this.keyDist).addScaledVector(t1, Math.cos(th) * rad).addScaledVector(t2, Math.sin(th) * rad);
        this.key.intensity = 2 * L.key * this.keyDist ** 2;
        this.floor.material.opacity = Math.min(1, 2 * L.strength * this.shadowMul());
      } else {
        // uniform sky dome sample
        const y = SKY_MIN + halton(j, 2) * (SKY_MAX - SKY_MIN), ph = halton(j, 3) * Math.PI * 2, k = Math.sqrt(1 - y * y);
        d.set(Math.cos(ph) * k, y, Math.sin(ph) * k);
        this.sun.intensity = 2 * L.sky * this.skyGain;
        this.floor.material.opacity = Math.min(1, 2 * L.ambient * this.shadowMul() * skyFade);
      }
      let jx = halton(n, 5) - 0.5, jy = halton(n, 7) - 0.5;
      // thin-lens depth of field: move the eye on the aperture, re-aim the frustum at the focus plane
      if (this.photo.fstop > 0) {
        const apR = (this.view.lens / this.photo.fstop) / 20; // aperture radius in cm
        const ar = Math.sqrt(halton(n, 11)) * apR, at = halton(n, 13) * Math.PI * 2;
        const ox = Math.cos(at) * ar, oy = Math.sin(at) * ar;
        cam.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        cam.position.addScaledVector(right, ox).addScaledVector(up, oy);
        const D = savedPos.distanceTo(this.controls.target);
        const pxPerCm = a.h / (2 * D * Math.tan((cam.fov * DEG) / 2));
        jx -= ox * pxPerCm; jy += oy * pxPerCm;
      }
      cam.setViewOffset(a.w, a.h, jx, jy, a.w, a.h);
    }
    // on the lit backdrop shadows are physical: the sliders set how much light an occluder blocks
    this.key.shadow.intensity = lit ? Math.min(1, 2 * L.strength * this.shadowMul()) : 1;
    this.sun.shadow.intensity = lit ? Math.min(1, 2 * L.ambient * this.shadowMul() * skyFade) : 1;
    this.key.visible = !!keyPos;
    this.sun.visible = !keyPos;
    const above = savedPos.y > 0;
    this.floor.visible = above && !lit;
    this.sweep.visible = above && lit;
    this.contact.plane.visible = above;
    this.bounce.intensity = above && lit ? L.bounce : 0;
    // seen from underneath there is no floor: light the underside like the top (mirrored rig)
    if (keyPos) {
      if (!above) keyPos.y = 2 * tgt.y - keyPos.y;
      this.key.position.copy(keyPos);
    } else {
      if (!above) d.y = -d.y;
      this.sun.position.copy(tgt).addScaledVector(d, this.lightDist);
    }
    this.scene.environmentRotation.x = above ? 0 : Math.PI;
    // the sweep's wall stands behind the set, opposite the camera
    this.sweep.position.set(tgt.x, 0, tgt.z);
    this.sweep.rotation.y = Math.atan2(savedPos.x - tgt.x, savedPos.z - tgt.z);
    r.setRenderTarget(a.sample);
    r.clear();
    r.render(this.scene, cam);
    cam.clearViewOffset();
    cam.position.copy(savedPos);
    cam.updateMatrixWorld();
    // running average (preview sample and first real sample replace the buffer)
    const q = this.blendQuad.material.uniforms;
    q.prev.value = a.rtA.texture; q.cur.value = a.sample.texture; q.w.value = n <= 1 ? 1 : 1 / n;
    r.setRenderTarget(a.rtB);
    r.render(this.blendQuad, this.quadCam);
    [a.rtA, a.rtB] = [a.rtB, a.rtA];
    a.n++;
    r.setRenderTarget(null);
  }

  setPhoto(opts) {
    Object.assign(this.photo, opts);
    this.invalidate();
  }

  present() {
    const u = this.presentQuad.material.uniforms, P = this.photo, a = this.acc;
    const bloom = this.transparentBg ? 0 : P.bloom;
    u.tDiffuse.value = a.rtA.texture;
    u.tBloom.value = bloom > 0 ? this.bloom.run(this.renderer, a.rtA.texture, a.w, a.h, this.quadCam) : a.rtA.texture;
    u.bloom.value = bloom;
    u.ca.value = P.ca;
    u.look.value = P.look;
    u.grain.value = P.grain;
    u.vignette.value = this.transparentBg ? 0 : P.vignette;
    u.seed.value = P.seed;
    u.res.value.set(a.w, a.h);
    const m = this.bgMedia;
    u.bgOn.value = m ? 1 : 0;
    if (m) {
      if (m.video && m.video.readyState >= 2) m.tex.needsUpdate = true;
      u.bgMap.value = m.tex;
      u.bgSize.value.set(m.w, m.h);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.presentQuad, this.quadCam);
  }

  // media: { el: HTMLImageElement | HTMLVideoElement, w, h } drawn behind the scene; the floor shadows land on it
  setBackground(color, transparent, media = null) {
    this.transparentBg = transparent && !media;
    // transparent or photo / video backdrop: no paper sweep, shadows only (composited over the media in present)
    this.shadowOnly = transparent || !!media;
    this.bg.set(color);
    this.scene.background = this.shadowOnly ? null : this.bg.clone();
    this.bgColor = color;
    if (this.bgMedia && this.bgMedia.el !== media?.el) this.bgMedia.tex.dispose();
    if (media && this.bgMedia?.el !== media.el) {
      const isVideo = media.el instanceof HTMLVideoElement;
      const tex = isVideo ? new THREE.VideoTexture(media.el) : new THREE.Texture(media.el);
      tex.colorSpace = THREE.NoColorSpace; // sampled as-is: composited after the output transform
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this.bgMedia = { ...media, tex, video: isVideo ? media.el : null };
    } else if (!media) this.bgMedia = null;
    // shadows take the colour of the surface they fall on: same hue, deeper and a little richer
    const hsl = this.bg.getHSL({});
    const tint = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.4), hsl.l * 0.12);
    this.contact.plane.material.color.copy(this.shadowOnly ? new THREE.Color(0) : tint);
    this.glintKey = ''; // re-tint the reflection studio on the next idle frame
    this.calibrate();
    this.invalidate();
  }

  // video backdrop: show frame at time t (seconds), used by the deterministic video export
  seekBackground(t) {
    const v = this.bgMedia?.video;
    if (!v || !v.duration) return Promise.resolve();
    v.pause();
    const time = t % v.duration;
    if (Math.abs(v.currentTime - time) < 1e-3) return Promise.resolve();
    return new Promise((res, rej) => {
      // never hang the export on a seek that doesn't complete
      const done = (err) => { clearTimeout(timer); v.removeEventListener('seeked', ok); v.removeEventListener('error', ko); err ? rej(err) : res(); };
      const ok = () => done(), ko = () => done(new Error('The background video could not be read.'));
      const timer = setTimeout(() => done(new Error('The background video stopped responding while seeking.')), 5000);
      v.addEventListener('seeked', ok);
      v.addEventListener('error', ko);
      v.currentTime = time;
    });
  }

  setLight(opts) {
    Object.assign(this.light, opts);
    const L = this.light;
    // contrast = key vs sky balance: 0 = flat and wrapped (overcast), 1 = a single hard source with deep shadows
    L.key = 2 + 3.25 * L.contrast;
    L.sky = 1.5 - 1.375 * L.contrast;
    const c = this.box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(Math.sin(L.az * DEG) * Math.cos(L.el * DEG), Math.sin(L.el * DEG), Math.cos(L.az * DEG) * Math.cos(L.el * DEG));
    const size = this.box.getSize(new THREE.Vector3()).length();
    this.lightDir = dir;
    this.key.target.position.copy(c);
    const height = this.box.max.y + 2;
    const reach = size / 2 + 3;

    // sky: directional. A shadow on the floor shares its light-space xy with its occluder, so the frustum only needs
    // to cover the objects themselves. Depth must reach the end of the longest grazing shadow (lowest sky sample).
    // Keeping the range tight keeps depth precision (and the bias, in cm) small -> shadows hug their objects.
    this.lightDist = size * 2 + 60;
    this.sun.position.copy(c).addScaledVector(dir, this.lightDist);
    const sc = this.sun.shadow.camera;
    const near = Math.max(0.5, this.lightDist - size / 2 - 5);
    const far = this.lightDist + size / 2 + height / SKY_MIN + 5;
    Object.assign(sc, { left: -reach, right: reach, top: reach, bottom: -reach, near, far });
    this.sun.shadow.bias = -0.012 / (far - near);
    sc.updateProjectionMatrix();

    // key: a softbox of radius keyRadius at keyDist. Closer (more Falloff) = stronger light gradient across the set.
    this.keyDist = size * (1 + 2.6 * (1 - L.falloff)) + 40;
    this.keyRadius = (0.02 + L.softness * 0.42) * this.keyDist;
    this.key.position.copy(c).addScaledVector(dir, this.keyDist);
    const ks = this.key.shadow, kc = ks.camera;
    const half = Math.atan(reach / Math.max(1, this.keyDist - reach)) * 1.05;
    ks.focus = half / this.key.angle; // shadow frustum hugs the objects, the light cone stays wide
    const lowEl = Math.max(5 * DEG, L.el * DEG - Math.atan(this.keyRadius / this.keyDist));
    kc.near = Math.max(1, this.keyDist - reach - this.keyRadius - 5);
    kc.far = Math.hypot(this.keyDist, this.keyRadius) + reach + height / Math.sin(lowEl) + 5;
    kc.updateProjectionMatrix();
    // perspective depth: convert a 0.012 cm world-space bias to depth-buffer units at the objects' distance
    ks.bias = (-0.012 * kc.near * kc.far) / (this.keyDist ** 2 * (kc.far - kc.near));

    this.key.color.copy(tempColor(L.warmth));
    this.sun.color.copy(tempColor(0.5 - (L.warmth - 0.5) * 0.6)); // sky leans the other way
    this.fill.color.copy(this.sun.color);
    this.contact.plane.material.opacity = Math.min(1, L.contact * this.shadowMul());
    this.scene.environmentIntensity = L.env;
    this.scene.environmentRotation.y = (L.az - 225) * DEG;
    this.calibrate();
    this.invalidate();
  }

  setGlint(v) { this.glint = v; this.glintKey = ''; this.invalidate(false); }

  // Re-bake the studio with a soft reflector at the mirror angle of the camera, for flat (up-facing) and
  // upright (front-facing) surfaces, so glossy spot varnish catches the light like in a product photo.
  updateGlint() {
    const cam = this.camera.position, t = this.controls.target;
    const v = cam.clone().sub(t).normalize();
    const key = (this.glint > 0 ? [v.x, v.y, v.z, this.scene.environmentRotation.y, this.glint].map((n) => n.toFixed(2)).join() : 'off') + this.bg.getHexString();
    if (key === this.glintKey || this.glintFrozen) return;
    this.glintKey = key;
    const glints = [];
    if (this.glint > 0 && v.y > 0) {
      const toEnv = new THREE.Matrix4().makeRotationY(-this.scene.environmentRotation.y);
      const I = 9 * this.glint;
      glints.push({ dir: new THREE.Vector3(-v.x, v.y, -v.z).applyMatrix4(toEnv), intensity: I }); // mirror of a flat surface
      glints.push({ dir: new THREE.Vector3(-v.x, -v.y, v.z).applyMatrix4(toEnv), intensity: I }); // mirror of a front-facing one
    }
    this.buildEnv(glints);
  }

  // one "Shadows" slider scales key shadow, ambient occlusion and contact together (0.5 = preset values)
  shadowMul() { return this.light.master * 2; }

  setLift(h) {
    this.lift = h;
    this.root.position.y = h;
    this.contact.fit(this.box);
    this.invalidate();
  }

  setBounds(box, points) {
    this.box.copy(box);
    const c = box.getCenter(new THREE.Vector3());
    this.turn.rotation.y = 0;
    this.turn.position.set(c.x, 0, c.z);
    this.root.position.set(-c.x, this.lift || 0, -c.z);
    this.fitPoints = points;
    const size = box.getSize(new THREE.Vector3());
    this.floor.scale.set(20000, 1, 20000);
    // the sweep's wall stays clear of the set even when it spins on the turntable
    this.sweep.geometry.dispose();
    this.sweep.geometry = sweepGeometry(Math.hypot(size.x, size.z) / 2 + 35, 70);
    this.contact.fit(box);
    this.setLight({});
  }

  setAspect(aspect, cssW, cssH) {
    this.aspect = aspect;
    this.renderer.setSize(cssW, cssH, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  // Frame (and size the shadow frustum) so the layout stays in shot for a whole motion.
  // pose(t) moves this.turn for t in [0, 1). Returns a function restoring the previous camera and bounds.
  frameForMotion(pose, steps = 24) {
    const cam = this.camera, turn = this.turn;
    const saved = {
      pts: this.fitPoints, box: this.box.clone(), pos: cam.position.clone(), target: this.controls.target.clone(),
      near: cam.near, far: cam.far, baseDist: this.baseDist, turnPos: turn.position.clone(), turnQ: turn.quaternion.clone(),
    };
    turn.updateMatrixWorld(true);
    const inv = turn.matrixWorld.clone().invert();
    const local = saved.pts.filter((_, i) => i % 3 === 0).map((p) => p.clone().applyMatrix4(inv));
    const pts = [], box = this.box.clone();
    for (let k = 0; k < steps; k++) {
      pose(k / steps);
      turn.updateMatrixWorld(true);
      for (const p of local) { const q = p.clone().applyMatrix4(turn.matrixWorld); pts.push(q); box.expandByPoint(q); }
    }
    turn.position.copy(saved.turnPos);
    turn.quaternion.copy(saved.turnQ);
    this.fitPoints = pts;
    this.box.copy(box);
    this.setLight({});
    this.frame();
    return () => {
      this.fitPoints = saved.pts;
      this.box.copy(saved.box);
      this.setLight({});
      Object.assign(cam, { near: saved.near, far: saved.far });
      cam.updateProjectionMatrix();
      cam.position.copy(saved.pos);
      this.controls.target.copy(saved.target);
      this.baseDist = saved.baseDist;
      cam.lookAt(saved.target);
      this.controls.update();
    };
  }

  // Place the camera from spherical angles and auto-fit the bounds.
  frame(view = {}, keepTarget = false) {
    Object.assign(this.view, view);
    const v = this.view;
    const cam = this.camera;
    cam.setFocalLength(v.lens);
    cam.aspect = this.aspect;
    cam.updateProjectionMatrix();
    const target = this.box.getCenter(new THREE.Vector3());
    const el = Math.min(v.el, 89.4) * DEG, az = v.az * DEG;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const camUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan((cam.fov * DEG) / 2);
    const tanH = tanV * cam.aspect;
    const m = v.zoom / 1.18; // breathing room around the layout at zoom 1
    const pts = this.fitPoints?.length ? this.fitPoints : boxCorners(this.box);
    const p = new THREE.Vector3();
    let d = 0;
    // fit distance, then re-centre the projected silhouette; a few iterations converge
    for (let iter = 0; iter < 4; iter++) {
      d = 0;
      for (const q of pts) {
        p.copy(q).sub(target);
        const depth = p.dot(dir);
        d = Math.max(d, depth + Math.abs(p.dot(right)) / (tanH * m), depth + Math.abs(p.dot(camUp)) / (tanV * m));
      }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of pts) {
        p.copy(q).sub(target);
        const z = d - p.dot(dir);
        const x = p.dot(right) / (z * tanH), y = p.dot(camUp) / (z * tanV);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      target.addScaledVector(right, ((x0 + x1) / 2) * d * tanH).addScaledVector(camUp, ((y0 + y1) / 2) * d * tanV);
    }
    cam.position.copy(target).addScaledVector(dir, d);
    cam.near = Math.max(0.5, d / 100);
    cam.far = d * 10 + 500;
    cam.updateProjectionMatrix();
    this.controls.target.copy(target);
    cam.lookAt(target);
    this.baseDist = d * v.zoom;
    this.controls.update();
  }

  syncViewFromCamera() {
    const off = this.camera.position.clone().sub(this.controls.target);
    const d = off.length();
    this.view.el = Math.asin(off.y / d) / DEG;
    this.view.az = Math.atan2(off.x, off.z) / DEG;
    if (this.baseDist) this.view.zoom = Math.max(0.2, Math.min(5, this.baseDist / d));
    this.onViewChange && this.onViewChange(this.view);
  }

  // Progressive preview: call every animation frame.
  step(budgetMs = 12) {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    // while the user drags / something animates: one cheap half-res frame; once idle: full-res accumulation
    const moving = performance.now() - this.lastInvalidate < 160;
    this.acc = moving ? this.accLo : this.accHi;
    if (moving) this.ensureTargets(size.x * this.loScale, size.y * this.loScale, 4);
    else {
      this.ensureTargets(size.x, size.y, 0);
      if (this.acc.n === 0) this.updateGlint();
    }
    if (this.acc.n >= this.acc.max) {
      if (this.bgMedia?.video) this.present(); // converged, but the backdrop keeps playing
      return;
    }
    this.beforeRender && this.beforeRender();
    const t0 = performance.now();
    do { this.accumulate(); } while (this.acc.n < this.acc.max && performance.now() - t0 < budgetMs && this.acc.n > 1);
    this.present();
  }

  // Render at an arbitrary pixel size; returns a canvas with the result.
  renderToCanvas(w, h, samples = 64, keep = false) {
    const r = this.renderer;
    const prevSize = r.getSize(new THREE.Vector2());
    const prevPR = r.getPixelRatio();
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const prevAcc = this.acc;
    this.acc = this.accEx;
    this.ensureTargets(w, h, 0);
    this.updateGlint();
    this.invalidate();
    this.beforeRender && this.beforeRender();
    for (let i = 0; i < samples; i++) this.accumulate();
    this.present();
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(this.canvas, 0, 0);
    r.setPixelRatio(prevPR);
    r.setSize(prevSize.x, prevSize.y, false);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.acc = prevAcc;
    if (!keep) { // free the big export buffers
      [this.accEx.rtA, this.accEx.rtB, this.accEx.sample].forEach((t) => t && t.dispose());
      this.accEx.rtA = null; this.accEx.w = 0;
    }
    this.invalidate();
    return out;
  }
}
