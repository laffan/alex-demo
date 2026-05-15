# The Alex Demos

A small series of demos that take a real, functioning text editor —
input, selection, undo, IME and all — and render its picture through
a layer of WebGL. The editor brain is always a hidden CodeMirror
instance; only what you see in front of it changes.

The trick they all share: split the editor in two. A headless
CodeMirror owns the document, the selection, and the history. A 2D
canvas paints a stylised picture of its state every frame. WebGL
treats *that canvas* as a texture — it never knows there's an editor
on the other end. Some demos do more than paint that canvas onto a
plane: they use it as a density field, an occlusion buffer for
god-rays, a heightfield for physics, or a glyph atlas for cloth
letters.

## The demos

1. **[ripple](demos/ripple/)** — dark ink on a tan page, bending
   under a domain-warp vertex shader and floating against a dark
   slate background. The original of the series.
2. **[tunnel-vision](demos/tunnel-vision/)** — thick sans-serif
   glyphs lit from inside a thin volumetric slab. The text canvas is
   the XY shape mask of the cloud; a raymarching fragment shader
   reads it against 3D fbm noise plus an animated heat-shimmer UV
   warp so the cloud visibly boils on top of its volumetrics.
3. **[stone-letters](demos/stone-letters/)** — the text canvas is
   converted into a Rapier 3D heightfield; small stones (smoothed
   icosahedra) drop above each typed letter and fill the trough that
   keystroke just carved. Pale ground, blue-shade stones, low
   friction so each burst slides off the trough walls into the
   indentation.
4. **[fabric-text](demos/fabric-text/)** — a piece of woven linen
   (image-textured) sitting over the document. A GPU-side cloth
   simulation pushes the surface up where text glyphs sit
   underneath, so typing extrudes the letters under the fabric.
5. **[beams](demos/beams/)** — light pours through the typed letters
   in single-pass radial-blur god-rays. The text atlas is the
   occlusion buffer; a fixed off-screen sun gives the streaks an
   angled cast.
6. **[breeze](demos/breeze/)** — each typed letter spawns a
   letter-shaped piece of cloth that drops from above and settles on
   a dark page below. The cloth runs a CPU Verlet simulation (same
   algorithm as the three.js WebGPU cloth example, just on the CPU)
   so each scrap folds and drapes as it falls.

Each demo folder contains its own `index.html`, `script.js`,
`styles.css`, and (where present) a `README.md` walkthrough.

## Running

Open `index.html` in the project root, or any demo folder, directly
in a browser. Or serve the repo:

```
python3 -m http.server 8000
# then visit http://localhost:8000/
```

No build step. `three` and CodeMirror load from `esm.sh`; fonts load
from Google Fonts; the stone-letters demo also pulls Rapier 3D via
`esm.sh`. The pages need network access on first load and nothing
afterward.

## Layout

```
.
├── index.html              # root landing page (navigation)
├── styles.css              # styling for the landing page
├── README.md               # this file
└── demos/
    ├── ripple/             # demo #01 — domain-warped page
    ├── tunnel-vision/      # demo #02 — volumetric letters
    ├── stone-letters/      # demo #03 — Rapier 3D heightfield + stones
    ├── fabric-text/        # demo #04 — GPU cloth over linen
    ├── beams/              # demo #05 — text-occluder god-rays
    └── breeze/             # demo #06 — letter-shaped CPU cloth drops
```
