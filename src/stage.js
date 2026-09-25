import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

const DEG = Math.PI / 180;

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
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
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
    const clearAlpha = r.getClearAlpha();
    r.setClearAlpha(0);
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, this.camera);
    scene.overrideMaterial = null;
    this.blurPass(this.blur);
    this.blurPass(this.blur * 0.4);
    r.setRenderTarget(null);
    r.setClearAlpha(clearAlpha);
    scene.background = bg;
    hide.forEach((o, i) => (o.visible = vis[i]));
    this.plane.visible = true;
  }
}

// Photo studio used for reflections only: dim room, big key softbox, overhead box, rim strip, fill card.
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
function studioEnvironment(glints = []) {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(120, 80, 120), new THREE.MeshBasicMaterial({ color: 0x4a4744, side: THREE.BackSide }));
  room.position.y = 25;
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8a817a }));
  floor.position.y = -14;
  scene.add(floor);
  const panel = (w, h, az, el, dist, intensity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide }));
    m.position.set(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG)).multiplyScalar(dist);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(34, 46, 225, 38, 40, 9); // key softbox (follows the key light via environmentRotation)
  panel(60, 60, 0, 88, 38, 1.3); // overhead
  panel(8, 50, 60, 18, 42, 5); // rim strip
  panel(46, 40, -30, 10, 44, 2.4); // white fill card behind the camera
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

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

function boxCorners(b) {
  return Array.from({ length: 8 }, (_, i) => new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
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
    this.envRT = this.pmrem.fromScene(studioEnvironment(), 0.02);
    scene.environment = this.envRT.texture;
    this.glint = 0; // "varnish reflector" strength
    this.glintKey = '';
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

    // key light
    const key = (this.key = new THREE.DirectionalLight(0xffffff, 2.2));
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.012;
    scene.add(key, key.target);

    this.fill = new THREE.HemisphereLight(0xffffff, 0xd8d0c8, 0.5);
    scene.add(this.fill);

    // floor catching key light shadows
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.35, transparent: true, depthWrite: false }),
    );
    this.floor.receiveShadow = true;
    this.floor.renderOrder = 2;
    scene.add(this.floor);

    this.contact = new ContactShadow(r);
    scene.add(this.contact.group);

    this.light = { az: 225, el: 42, softness: 0.6, strength: 0.3, ambient: 0.55, contact: 0.35, master: 0.5, env: 0.42, key: 1.85, sky: 0.95 };
    this.photo = { fstop: 5.6, grain: 0.35, vignette: 0.2, seed: 0 };
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
    const quad = (frag, uniforms) => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: frag,
    }));
    this.blendQuad = quad(`uniform sampler2D prev, cur; uniform float w; varying vec2 vUv;
      void main(){ gl_FragColor = mix(texture2D(prev, vUv), texture2D(cur, vUv), w); }`,
    { prev: { value: null }, cur: { value: null }, w: { value: 1 } });
    this.presentQuad = quad(`uniform sampler2D tDiffuse; uniform float grain, vignette, seed; uniform vec2 res; varying vec2 vUv;
      float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031 + seed * .0137); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        gl_FragColor = c;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // lens falloff
        vec2 d = vUv - 0.5; d.x *= res.x / res.y;
        gl_FragColor.rgb *= 1.0 - vignette * smoothstep(0.35, 1.0, length(d));
        // film grain, resolution independent, strongest in the mid-tones
        vec2 gp = floor(vUv * vec2(res.x / res.y, 1.0) * 1500.0);
        float nz = hash(gp) + hash(gp + 71.3) - 1.0;
        float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
        gl_FragColor.rgb += nz * grain * 0.055 * (0.3 + 0.7 * (1.0 - abs(lum * 2.0 - 1.0))) * gl_FragColor.a;
      }`, { tDiffuse: { value: null }, grain: { value: 0 }, vignette: { value: 0 }, seed: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } });
    this.presentQuad.material.toneMapped = true;
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
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
  // n = 0 is a fast preview (key + unshadowed fill); n >= 1 alternates key-softbox and sky samples,
  // each casting shadows, which converges to soft area shadows + ambient occlusion. Camera jitter adds AA & depth of field.
  accumulate() {
    const r = this.renderer, a = this.acc, n = a.n, L = this.light, cam = this.camera;
    if (this.contactDirty) { this.contact.update(this.scene, [this.floor]); this.contactDirty = false; }
    const d = this.lightDir.clone();
    const savedPos = cam.position.clone();
    if (n === 0) {
      this.key.intensity = L.key;
      this.fill.intensity = L.sky * 0.45;
      this.floor.material.opacity = Math.min(1, L.strength * this.shadowMul());
    } else {
      const i = n - 1, j = Math.floor(i / 2) + 1;
      this.fill.intensity = 0;
      if (i % 2 === 0) {
        const spread = 0.02 + L.softness * 0.42;
        const rad = Math.sqrt(halton(j, 2)) * spread, th = halton(j, 3) * Math.PI * 2;
        const t1 = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
        const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
        d.addScaledVector(t1, Math.cos(th) * rad).addScaledVector(t2, Math.sin(th) * rad).normalize();
        this.key.intensity = 2 * L.key;
        this.floor.material.opacity = Math.min(1, 2 * L.strength * this.shadowMul());
      } else {
        // uniform sky dome sample (above ~8 deg)
        const y0 = Math.sin(18 * DEG), y = y0 + halton(j, 2) * (1 - y0), ph = halton(j, 3) * Math.PI * 2, k = Math.sqrt(1 - y * y);
        d.set(Math.cos(ph) * k, y, Math.sin(ph) * k);
        this.key.intensity = 2 * L.sky;
        this.floor.material.opacity = Math.min(1, 2 * L.ambient * this.shadowMul());
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
    this.key.position.copy(this.key.target.position).addScaledVector(d, this.lightDist);
    const above = savedPos.y > 0;
    this.floor.visible = this.contact.plane.visible = above;
    // seen from underneath there is no floor: light the underside like the top (mirrored rig)
    if (!above) {
      d.y = -d.y;
      this.key.position.copy(this.key.target.position).addScaledVector(d, this.lightDist);
      this.scene.environmentRotation.x = Math.PI;
    } else this.scene.environmentRotation.x = 0;
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
    const u = this.presentQuad.material.uniforms, P = this.photo;
    u.tDiffuse.value = this.acc.rtA.texture;
    u.grain.value = P.grain;
    u.vignette.value = this.transparentBg ? 0 : P.vignette;
    u.seed.value = P.seed;
    u.res.value.set(this.acc.w, this.acc.h);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.presentQuad, this.quadCam);
  }

  setBackground(color, transparent) {
    this.transparentBg = transparent;
    this.scene.background = transparent ? null : new THREE.Color(color);
    this.bgColor = color;
    this.invalidate();
  }

  setLight(opts) {
    Object.assign(this.light, opts);
    const L = this.light;
    const c = this.box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(Math.sin(L.az * DEG) * Math.cos(L.el * DEG), Math.sin(L.el * DEG), Math.cos(L.az * DEG) * Math.cos(L.el * DEG));
    const size = this.box.getSize(new THREE.Vector3()).length();
    this.lightDir = dir;
    this.lightDist = size * 2 + 60;
    this.key.position.copy(c).addScaledVector(dir, this.lightDist);
    this.key.target.position.copy(c);
    const sc = this.key.shadow.camera;
    // A shadow on the floor shares its light-space xy with its occluder, so the frustum only needs to cover the
    // objects themselves. Depth must reach the end of the longest grazing shadow (lowest sky sample is 18 deg).
    // Keeping the range tight keeps depth precision (and the bias, in cm) small -> shadows hug their objects.
    const half = size / 2 + 3;
    const height = this.box.max.y + 2;
    const near = Math.max(0.5, this.lightDist - size / 2 - 5);
    const far = this.lightDist + size / 2 + height / Math.sin(18 * DEG) + 5;
    Object.assign(sc, { left: -half, right: half, top: half, bottom: -half, near, far });
    this.key.shadow.bias = -0.012 / (far - near);
    sc.updateProjectionMatrix();
    this.contact.plane.material.opacity = Math.min(1, L.contact * this.shadowMul());
    this.scene.environmentIntensity = L.env;
    this.scene.environmentRotation.y = (L.az - 225) * DEG;
    this.invalidate();
  }

  setGlint(v) { this.glint = v; this.glintKey = ''; this.invalidate(false); }

  // Re-bake the studio with a soft reflector at the mirror angle of the camera, for flat (up-facing) and
  // upright (front-facing) surfaces, so glossy spot varnish catches the light like in a product photo.
  updateGlint() {
    const cam = this.camera.position, t = this.controls.target;
    const v = cam.clone().sub(t).normalize();
    const key = this.glint > 0 ? [v.x, v.y, v.z, this.scene.environmentRotation.y, this.glint].map((n) => n.toFixed(2)).join() : 'off';
    if (key === this.glintKey || this.glintFrozen) return;
    this.glintKey = key;
    const glints = [];
    if (this.glint > 0 && v.y > 0) {
      const toEnv = new THREE.Matrix4().makeRotationY(-this.scene.environmentRotation.y);
      const I = 9 * this.glint;
      glints.push({ dir: new THREE.Vector3(-v.x, v.y, -v.z).applyMatrix4(toEnv), intensity: I }); // mirror of a flat surface
      glints.push({ dir: new THREE.Vector3(-v.x, -v.y, v.z).applyMatrix4(toEnv), intensity: I }); // mirror of a front-facing one
    }
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(studioEnvironment(glints), 0.02);
    this.scene.environment = this.envRT.texture;
    old.dispose();
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
    const s = 20000;
    this.floor.scale.set(s, 1, s);
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

  // Frame so the layout stays in shot for a full turntable revolution. Returns a restore function.
  frameForTurntable() {
    const saved = this.fitPoints;
    const c = this.turn.position;
    const pts = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (const p of saved) {
        const x = p.x - c.x, z = p.z - c.z;
        pts.push(new THREE.Vector3(c.x + x * ca + z * sa, p.y, c.z - x * sa + z * ca));
      }
    }
    this.fitPoints = pts.filter((_, i) => i % 3 === 0);
    this.frame();
    return () => { this.fitPoints = saved; this.frame(); };
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
    const m = v.zoom / 1.12;
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
    if (this.acc.n >= this.acc.max) return;
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
