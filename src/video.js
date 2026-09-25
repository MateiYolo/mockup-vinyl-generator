import * as THREE from 'three';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const DEG = Math.PI / 180;

async function pickCodec(w, h, fps) {
  for (const codec of ['avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.4D0033', 'avc1.42E033']) {
    const cfg = { codec, width: w, height: h, bitrate: 16_000_000, framerate: fps };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(cfg);
      if (supported) return cfg;
    } catch { /* try next */ }
  }
  throw new Error('H.264 encoding is not supported in this browser (use Chrome or Edge).');
}

// ---- loop motions, shared by the live preview and the MP4 renderer ----
export const MOTIONS = {
  spin: 'Only the record spins, camera locked.',
  sway: 'Record spins while the camera gently drifts left/right.',
  turntable: 'Full 360° at constant speed: flat lays float and turn about the Z axis (front, then back), upright scenes turn on a turntable. Lights stay fixed.',
};

const TAU = Math.PI * 2;
const swayAz = (t) => Math.sin(t * TAU) * 14 * DEG;
const Z = new THREE.Vector3(0, 0, 1);

// Flat lays: a turntable (Y) only spins them in place, so they turn about the world Z axis instead, at a constant
// speed, floating just high enough to clear the floor for the whole turn. Z only: no X/Y rotation, no bob.
function setupFlip(b) {
  const { stage } = b, turn = stage.turn;
  turn.updateMatrixWorld(true);
  const inv = turn.matrixWorld.clone().invert();
  // farthest point from the Z axis through the pivot = how low the layout reaches while turning
  const reach = Math.max(...stage.fitPoints.map((p) => { const q = p.clone().applyMatrix4(inv); return Math.hypot(q.x, q.y); }));
  Object.assign(b, { flipH: reach + 1, flipQ: new THREE.Quaternion() });
}

function flipPose(b, t) {
  const turn = b.stage.turn;
  turn.quaternion.copy(b.turnQ0).premultiply(b.flipQ.setFromAxisAngle(Z, t * TAU));
  turn.position.copy(b.turnPos0);
  turn.position.y += b.flipH;
  // a floating object's sky shadow is too diffuse to resolve with a few dozen samples: fade it instead
  b.stage.skyShadow = 1 / (1 + b.flipH / 3);
}

export function beginMotion(stage, vinyl, { motion, flip = false }) {
  stage.updateGlint();
  stage.glintFrozen = true; // the varnish reflector stays put in the world while things move
  const cam = stage.camera;
  const b = {
    stage, vinyl, cam, flip: motion === 'turntable' && flip,
    spin0: vinyl.spin.rotation.y, turnQ0: stage.turn.quaternion.clone(), turnPos0: stage.turn.position.clone(),
  };
  // re-frame so the whole layout stays in shot during the full motion
  if (motion === 'turntable') {
    if (b.flip) setupFlip(b);
    b.restoreFrame = stage.frameForMotion((t) => poseTurntable(b, t));
  } else if (motion === 'sway') {
    // orbiting the camera by +a frames like turning the layout by -a (pad the small tilt drift too)
    b.restoreFrame = stage.frameForMotion((t) => {
      stage.turn.quaternion.copy(b.turnQ0);
      stage.turn.rotateY(-swayAz(t) * 1.1);
    });
  }
  const target = (b.target = stage.controls.target.clone());
  b.startPos = cam.position.clone();
  const off = b.startPos.clone().sub(target);
  b.dist = off.length();
  b.el0 = Math.asin(off.y / b.dist);
  b.az0 = Math.atan2(off.x, off.z);
  return b;
}

function poseTurntable(b, t) {
  if (b.flip) return flipPose(b, t);
  b.stage.turn.quaternion.copy(b.turnQ0);
  b.stage.turn.rotateY(t * TAU);
}

export function applyMotion(b, t, { motion, turns }) {
  let az = b.az0, el = b.el0;
  if (motion === 'turntable') {
    poseTurntable(b, t);
  } else {
    b.vinyl.spin.rotation.y = b.spin0 - t * turns * TAU;
    if (motion === 'sway') {
      az += swayAz(t);
      el += Math.sin(t * TAU * 2) * 3 * DEG;
    }
  }
  b.cam.position.set(
    b.target.x + Math.sin(az) * Math.cos(el) * b.dist,
    b.target.y + Math.sin(el) * b.dist,
    b.target.z + Math.cos(az) * Math.cos(el) * b.dist,
  );
  b.cam.lookAt(b.target);
}

export function endMotion(b) {
  b.stage.glintFrozen = false;
  b.stage.skyShadow = 1;
  b.vinyl.spin.rotation.y = b.spin0;
  b.stage.turn.quaternion.copy(b.turnQ0);
  b.stage.turn.position.copy(b.turnPos0);
  b.cam.position.copy(b.startPos);
  b.cam.lookAt(b.target);
  b.restoreFrame && b.restoreFrame();
}

// Encoders: H.264 MP4 (opaque), or ProRes 4444 with an alpha channel for transparent backgrounds.
async function mp4Writer(w, h, fps) {
  if (!('VideoEncoder' in window)) throw new Error('WebCodecs is not available in this browser (use Chrome or Edge).');
  const cfg = await pickCodec(w, h, fps);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encErr = e),
  });
  encoder.configure(cfg);
  return {
    async add(canvas, i) {
      if (encErr) throw encErr;
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    },
    async finish() {
      await encoder.flush();
      if (encErr) throw encErr;
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
    close() { if (encoder.state !== 'closed') encoder.close(); },
  };
}

// Make ffmpeg's ProRes 4444 decode with alpha in Apple apps (QuickTime, Final Cut, AVFoundation...):
// - Apple ignores the alpha plane of multi-slice frames unless the frame header says version 1 (ffmpeg writes 0);
// - Apple's alpha decoder needs a little slack after each slice's alpha data: when ffmpeg's alpha stream ends within
//   a byte or two of the slice end, Apple drops the rest of that slice's alpha -> black blocks in the video.
// So every frame is rebuilt with 4 zero bytes appended to each slice (ffmpeg and Apple both ignore them), and the
// sample sizes / chunk offsets of the .mov are updated to match.
const SLICE_SLACK = 4;

const tag4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function boxes(buf, start, end) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = [];
  for (let pos = start; pos + 8 <= end;) {
    let size = dv.getUint32(pos), head = 8;
    if (size === 1) { size = Number(dv.getBigUint64(pos + 8)); head = 16; } else if (size === 0) size = end - pos;
    if (size < 8) break;
    out.push({ type: tag4(buf, pos + 4), pos, size, data: pos + head });
    pos += size;
  }
  return out;
}

function findBoxes(buf, list, found = {}) {
  for (const b of list) {
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(b.type)) findBoxes(buf, boxes(buf, b.data, b.pos + b.size), found);
    else (found[b.type] ||= b);
  }
  return found;
}

// size of a ProRes frame once each of its slices is padded
function paddedFrameSize(dv, f) {
  const pic = f + 8 + dv.getUint16(f + 8);
  return dv.getUint32(f) + dv.getUint16(pic + 5) * SLICE_SLACK;
}

// copies the frame at buf[f] into out[o] with the padded slices; returns the bytes written
function padProresFrame(buf, f, out, o) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hdr = dv.getUint16(f + 8); // frame header size, counted from this field
  const pic = f + 8 + hdr, picHdr = buf[pic] >> 3;
  const n = dv.getUint16(pic + 5); // slices
  const table = pic + picHdr;
  const outSize = dv.getUint32(f) + n * SLICE_SLACK;
  const ov = new DataView(out.buffer, out.byteOffset + o, outSize);
  out.set(buf.subarray(f, table), o); // frame size, 'icpf', frame header, picture header
  ov.setUint32(0, outSize);
  ov.setUint16(10, 1); // frame header version 1
  const picOut = pic - f;
  ov.setUint32(picOut + 1, dv.getUint32(pic + 1) + n * SLICE_SLACK); // picture size
  let src = table + 2 * n, dst = table - f + 2 * n;
  for (let i = 0; i < n; i++) {
    const size = dv.getUint16(table + 2 * i);
    if (size + SLICE_SLACK > 0xffff) throw new Error('ProRes slice too large to pad.');
    ov.setUint16(table - f + 2 * i, size + SLICE_SLACK);
    out.set(buf.subarray(src, src + size), o + dst);
    out.fill(0, o + dst + size, o + dst + size + SLICE_SLACK);
    src += size; dst += size + SLICE_SLACK;
  }
  return outSize;
}

function fixProresMov(mov) {
  const top = boxes(mov, 0, mov.length);
  const mdat = top.find((b) => b.type === 'mdat'), moov = top.find((b) => b.type === 'moov');
  if (!mdat || !moov || moov.pos < mdat.pos) throw new Error('Unexpected .mov layout.');
  const t = findBoxes(mov, [moov]);
  const co = t.stco || t.co64;
  if (!t.stsz || !t.stsc || !co) throw new Error('Unexpected .mov layout.');
  const dv = new DataView(mov.buffer, mov.byteOffset, mov.byteLength);

  // frames are stored back to back in mdat. Sizes first, so the padded frames are written straight into the output
  // (no per-frame copies: a long 4444 clip is several hundred MB)
  const frames = [];
  for (let f = mdat.data; f + 12 <= mdat.pos + mdat.size && tag4(mov, f + 4) === 'icpf'; f += dv.getUint32(f)) {
    frames.push({ src: f, size: paddedFrameSize(dv, f) });
  }
  const count = dv.getUint32(t.stsz.data + 8);
  if (frames.length !== count) throw new Error('Unexpected ProRes stream.');

  // new file: everything before mdat, new mdat, moov with patched tables
  const payload = frames.reduce((n, f) => n + f.size, 0);
  const large = payload + 8 > 0xffffffff;
  const head = large ? 16 : 8;
  const before = mov.subarray(0, mdat.pos);
  const moovBytes = mov.slice(moov.pos, moov.pos + moov.size);
  const out = new Uint8Array(before.length + head + payload + moovBytes.length);
  const odv = new DataView(out.buffer);
  out.set(before);
  let p = before.length;
  if (large) { odv.setUint32(p, 1); out.set([109, 100, 97, 116], p + 4); odv.setBigUint64(p + 8, BigInt(head + payload)); }
  else { odv.setUint32(p, head + payload); out.set([109, 100, 97, 116], p + 4); }
  p += head;
  const offsets = [];
  for (const f of frames) { offsets.push(p); p += padProresFrame(mov, f.src, out, p); }
  const m = p, mv = new DataView(out.buffer, m);
  out.set(moovBytes, m);
  const rel = (b) => b.pos - moov.pos;

  // stsz: per-sample sizes (or the single constant size of a one-frame clip)
  const sz = rel(t.stsz) + (t.stsz.data - t.stsz.pos);
  if (mv.getUint32(sz + 4) !== 0) {
    if (frames.some((f) => f.size !== frames[0].size)) throw new Error('Unexpected ProRes sample table.');
    mv.setUint32(sz + 4, frames[0].size);
  } else frames.forEach((f, i) => mv.setUint32(sz + 12 + 4 * i, f.size));

  // stsc -> samples per chunk, then rewrite each chunk offset to its first sample
  const sc = t.stsc.data, nsc = dv.getUint32(sc + 4);
  const runs = Array.from({ length: nsc }, (_, i) => [dv.getUint32(sc + 8 + 12 * i), dv.getUint32(sc + 12 + 12 * i)]);
  const cz = rel(co) + (co.data - co.pos), nChunks = mv.getUint32(cz + 4);
  let sample = 0;
  for (let c = 1, r = 0; c <= nChunks; c++) {
    while (r + 1 < runs.length && runs[r + 1][0] <= c) r++;
    const off = offsets[sample];
    if (co.type === 'co64') mv.setBigUint64(cz + 8 + 8 * (c - 1), BigInt(off));
    else if (off > 0xffffffff) throw new Error('Video too large for this .mov layout.');
    else mv.setUint32(cz + 8 + 4 * (c - 1), off);
    sample += runs[r][1];
  }
  return out;
}

// ProRes 4444 (.mov) keeps the alpha channel and opens everywhere (QuickTime, Final Cut, Premiere, After Effects,
// DaVinci...). Encoded with ffmpeg.wasm, loaded on demand. Frames go in as raw RGBA in short segments to keep the
// wasm memory small, then the segments are joined without re-encoding.
async function proresWriter(w, h, fps, onStatus) {
  onStatus && onStatus('Loading the ProRes encoder…');
  const [{ FFmpeg }, { default: coreURL }, { default: wasmURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'), import('@ffmpeg/core?url'), import('@ffmpeg/core/wasm?url'),
  ]);
  const ff = new FFmpeg();
  await ff.load({ coreURL, wasmURL });
  const SEG = 12, segs = [];
  let frames = [];
  const run = async (args) => {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error('ProRes encoding failed (ffmpeg exit code ' + code + ').');
  };
  const flush = async () => {
    if (!frames.length) return;
    const raw = new Uint8Array(frames.length * w * h * 4);
    frames.forEach((f, i) => raw.set(f, i * w * h * 4));
    frames = [];
    await ff.writeFile('in.rgba', raw);
    const name = `s${segs.length}.mov`;
    await run([
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', String(fps), '-i', 'in.rgba',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv',
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', name,
    ]);
    await ff.deleteFile('in.rgba');
    segs.push(name);
  };
  return {
    async add(canvas) {
      // straight (non-premultiplied) RGBA, which is what ProRes stores
      frames.push(canvas.getContext('2d').getImageData(0, 0, w, h).data);
      if (frames.length >= SEG) await flush();
    },
    async finish() {
      await flush();
      onStatus && onStatus('Writing the .mov…');
      await ff.writeFile('list.txt', segs.map((n) => `file '${n}'`).join('\n'));
      await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.mov']); // moov last: fixProresMov relies on it
      // free the worker's in-memory files as soon as possible: the whole clip would otherwise be held 2-3 times
      for (const n of [...segs, 'list.txt']) await ff.deleteFile(n);
      const mov = await ff.readFile('out.mov');
      await ff.deleteFile('out.mov');
      return new Blob([fixProresMov(mov)], { type: 'video/quicktime' });
    },
    close() { ff.terminate(); },
  };
}

// Renders a seamless loop frame-by-frame (deterministic, not real-time) and encodes it.
// alpha: transparent background -> ProRes 4444 .mov, otherwise MP4 (H.264).
export async function renderLoop({ stage, vinyl, w, h, fps, duration, turns, motion, flip, alpha, onProgress, onStatus }) {
  const writer = alpha ? await proresWriter(w, h, fps, onStatus) : await mp4Writer(w, h, fps);
  const base = beginMotion(stage, vinyl, { motion, flip });
  const frames = Math.round(duration * fps);
  const samples = 56;
  const bgVideo = stage.bgMedia?.video;
  const wasPlaying = bgVideo && !bgVideo.paused;

  try {
    for (let i = 0; i < frames; i++) {
      await stage.seekBackground(i / fps);
      applyMotion(base, i / frames, { motion, turns }); // t in [0, 1): frame N == frame 0, seamless
      stage.photo.seed = i;
      await writer.add(stage.renderToCanvas(w, h, samples), i);
      if (i % 3 === 0) {
        onProgress && onProgress(i / frames);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return await writer.finish();
  } finally {
    writer.close();
    stage.photo.seed = 0;
    endMotion(base);
    if (wasPlaying) bgVideo.play();
  }
}
