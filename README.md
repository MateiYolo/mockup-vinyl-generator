# Vinyl Mockup Studio

Local 3D mockup generator for vinyl releases: sleeve, insert, labels and disc, rendered with Three.js.

```bash
npm install
npm run dev   # http://localhost:5178
```

- **Scene presets**: flat stack, sleeve + vinyl, standing, full bundle, vinyl only, vinyl hero, front cover, back cover, front + back, insert.
- **Vinyl**: artwork texture (top-down PNG of the disc), black, white, clear, smoke, tinted, colour, procedural marble, splatter and split. Grooves and the anisotropic sheen are procedural.
- **Artwork**: drop images on the slots. Defaults are in `public/assets/`.
- **Realism**: sleeve board is rounded, slightly warped and fibre-bumped, with ring wear, edge wear and uneven paper tone (Wear / Warp sliders). Vinyl has music-dependent groove banding, track gaps, micro-scratches, fingerprints, surface waviness and a dust layer (Dust slider). Labels have paper grain and a stamped ring.
- **Spot varnish**: drop a mask per side (any colour on transparent = varnish). The masked areas get a mirror-like clearcoat with slightly raised edges and deepened ink; a *Reflector* (soft strip light at the camera's mirror angle) makes the varnish catch the light, and it sweeps in and out during 360° loops.
- **Photo**: thin-lens depth of field (f/11 → f/1.4), film grain and lens vignette.
- **Rendering**: progressive accumulation. Samples alternate between a jittered key softbox and a shadow-casting sky dome, which gives soft contact-hardened shadows plus real ambient occlusion. Reflections come from a procedural photo-studio environment. While you interact the preview renders at half resolution; once you stop, it converges at full resolution in about a second.
- **Background**: preset colours, a custom colour, transparent, or your own photo / video (drop it on the Background panel). The image fills the frame and shadows fall onto it; a video backdrop plays in the preview and is exported frame-accurately (the loop length is matched to the video so both loop together).
- **Export**: PNG at 2K/3K/4K in the selected frame ratio, optionally with a transparent background. You can also export a seamless video loop in the same frame ratio (1080 px on the short side): MP4 (H.264), or ProRes 4444 .mov with alpha when the background is transparent (encoded with ffmpeg.wasm, loaded on demand; opens in QuickTime, Final Cut, Premiere, After Effects and DaVinci). Motions: disc spin, spin + camera drift, or 360°. In 360°, flat lays float and turn about the Z axis only, at constant speed (front, then back); upright scenes turn on a turntable. Lights stay fixed. **▶ Preview loop** (or Space) plays the exact loop in real time before you render. This needs Chrome or Edge.

`vite.config.js` includes a dev-only `/__snap` endpoint that writes renders to `.snaps/` for visual QA.
