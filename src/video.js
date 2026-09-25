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
  turntable: 'The whole scene turns 360° like on a turntable (lights stay fixed).',
};

export function beginMotion(stage, vinyl, motion) {
  // turntable: re-frame so the whole layout stays in shot during the full revolution
  const restoreFrame = motion === 'turntable' ? stage.frameForTurntable() : null;
  stage.updateGlint();
  stage.glintFrozen = true; // the varnish reflector stays put in the world while things move
  const cam = stage.camera, target = stage.controls.target.clone();
  const startPos = cam.position.clone();
  const off = startPos.clone().sub(target);
  const dist = off.length();
  return {
    stage, vinyl, cam, target, startPos, dist, restoreFrame,
    el0: Math.asin(off.y / dist), az0: Math.atan2(off.x, off.z),
    spin0: vinyl.spin.rotation.y, turn0: stage.turn.rotation.y,
  };
}

export function applyMotion(b, t, { motion, turns }) {
  const TAU = Math.PI * 2;
  let az = b.az0, el = b.el0;
  if (motion === 'turntable') {
    b.stage.turn.rotation.y = b.turn0 + t * TAU;
  } else {
    b.vinyl.spin.rotation.y = b.spin0 - t * turns * TAU;
    if (motion === 'sway') {
      az += Math.sin(t * TAU) * 14 * DEG;
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
  b.vinyl.spin.rotation.y = b.spin0;
  b.stage.turn.rotation.y = b.turn0;
  b.cam.position.copy(b.startPos);
  b.cam.lookAt(b.target);
  b.restoreFrame && b.restoreFrame();
}

// Renders a seamless loop frame-by-frame (deterministic, not real-time) and muxes it to MP4.
export async function renderLoop({ stage, vinyl, w, h, fps, duration, turns, motion, onProgress }) {
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

  const base = beginMotion(stage, vinyl, motion);
  const frames = Math.round(duration * fps);
  const samples = 56;

  try {
    for (let i = 0; i < frames; i++) {
      if (encErr) throw encErr;
      applyMotion(base, i / frames, { motion, turns }); // t in [0, 1): frame N == frame 0, seamless
      stage.photo.seed = i;
      const frameCanvas = stage.renderToCanvas(w, h, samples);
      const frame = new VideoFrame(frameCanvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      if (i % 3 === 0) {
        onProgress && onProgress(i / frames);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await encoder.flush();
    if (encErr) throw encErr;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    stage.photo.seed = 0;
    endMotion(base);
  }
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
