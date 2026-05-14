# Editor in WebGL — demos

A small series of demos that take a real, functioning text editor —
input, selection, undo, IME and all — and render its picture through
a layer of WebGL. The editor brain is always a hidden CodeMirror
instance; only what you see in front of it changes.

The trick they all share: split the editor in two. A headless
CodeMirror owns the document, the selection, and the history. A 2D
canvas paints a stylised picture of its state every frame. WebGL
treats *that canvas* as a texture — it never knows there's an editor
on the other end.

## The demos

1. **[undulating-surface](demos/undulating-surface/)** — the
   original. Dark brown serif on a tan page, bending under a domain-
   warp shader. A surface you can write on like cloth.
2. **[cloud-text](demos/cloud-text/)** — thick sans-serif glyphs lit
   from inside a thin volumetric slab. The text canvas is read as a
   density field; a fragment shader raymarches it against 3D fbm
   noise to read as smoke.
3. **[stone-letters](demos/stone-letters/)** — each glyph
   reconstituted as a few hundred small 3D pebbles via
   `InstancedMesh`. The rasterised text canvas is sampled at a fixed
   stride; every lit pixel becomes one stone.

Each demo folder contains its own `index.html`, `script.js`,
`styles.css`, and a `README.md` walkthrough.

## Running

Open `index.html` in the project root, or any demo folder, directly
in a browser. Or serve the repo:

```
python3 -m http.server 8000
# then visit http://localhost:8000/
```

No build step. `three` and CodeMirror load from `esm.sh`; fonts load
from Google Fonts. The pages need network access on first load and
nothing afterward.

## Layout

```
.
├── index.html           # root landing page (navigation)
├── styles.css           # styling for the landing page
├── README.md            # this file
└── demos/
    ├── undulating-surface/   # demo #01
    ├── cloud-text/           # demo #02
    └── stone-letters/        # demo #03
```
