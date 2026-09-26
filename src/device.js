// Memory budget. Phones and tablets (iOS above all) kill the tab outright once the page goes past roughly
// 1-1.5 GB of canvases + GPU textures, and Safari just reloads it ("a problem repeatedly occurred").
// At full size the procedural maps alone are ~660 MB of 2D canvases, plus their GPU copies and two 4K shadow maps,
// so on those devices every map is baked at half resolution (a quarter of the memory). The preview on a phone
// screen is a few hundred pixels wide: the difference doesn't show.
const ua = navigator.userAgent;
const iOS = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPadOS says "Mac"
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const smallMem = (navigator.deviceMemory || 8) <= 4;
const forced = new URLSearchParams(location.search).get('mem'); // ?mem=low / ?mem=high to test either tier

export const LOW_MEM = forced ? forced === 'low' : iOS || coarse || smallMem;

export const TEX = LOW_MEM
  ? { grooves: 2048, art: 1024, shadow: 2048, exportMax: 3000 }
  : { grooves: 4096, art: 2048, shadow: 4096, exportMax: Infinity };

// Release a scratch canvas' backing store now instead of whenever the GC gets to it (Safari counts live canvases).
export function freeCanvas(...cs) {
  for (const c of cs) if (c) c.width = c.height = 0;
}
