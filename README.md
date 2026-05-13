# Editor in 3D

A demo where a [CodeMirror 6](https://codemirror.net) markdown editor is
rendered onto a domain-warped plane in [three.js](https://threejs.org). The
text is the only light source. The surface bends. You can still type.

## How it works

The trick is splitting the editor in two: one piece owns the input, another
owns the picture.

1. **Hidden CodeMirror 6 instance.** A real editor lives in an off-screen
   `<div>` (`#editor-host`). It handles every keystroke, selection change,
   undo step, and markdown language feature — but nothing it paints is ever
   visible to the user. Clicking the WebGL canvas calls `view.focus()` to
   route keyboard input into it.

2. **2D texture canvas.** Every animation frame we walk
   `view.state.doc` line by line and draw a stylised version of the document
   onto an off-screen 2D canvas (2048 × 2048) at **100 px** body text:
   - `#`, `##` … get progressively heavier weights
   - Fenced ``` lines render italic
   - Blockquote lines get a vertical bar in the gutter
   - A blinking caret is drawn at `selection.main.head` using `measureText`
   - The viewport scrolls vertically to keep the caret on-screen

3. **CanvasTexture → ShaderMaterial.** That 2D canvas is wrapped in a
   `THREE.CanvasTexture`, set to `needsUpdate = true` each frame, and
   applied to a `PlaneGeometry(3.2, 3.2, 144, 144)` — a heavily subdivided
   plane so it can deform smoothly.

4. **Domain-warped vertex shader.** The plane's z-coordinate is displaced
   by an almost-verbatim port of Inigo Quilez's
   [Base warp fBM](https://www.shadertoy.com/view/3sfczf) shader:
   `sin(x)*sin(y)` as a cheap noise primitive, `fbm4` / `fbm6` stacking
   rotated octaves (matrix `m`, frequency multiplier `2.02`), and a
   `baseWarp` function that runs two passes of domain warping
   (`q → o → n`) before a final fBM, then sharpens with
   `mix(f, f*f*f*3.5, f * |n.x|)`. The result is sampled per-vertex and
   used as the height field — same flowing curves as the original, but
   pushed into geometry instead of pixels.

5. **Fragment shader.** Samples the canvas texture, converts to luminance
   for a pure black-and-white look, applies a soft vignette, and brightens
   ridges / darkens troughs using the warp amount as a varying. Result: the
   text gains a physical sense of being painted onto a bending sheet.

## Files

- `index.html` — mounts the WebGL canvas (`#stage`) and the hidden editor
  host (`#editor-host`)
- `styles.css` — full-screen black, hides the editor host off-screen
- `script.js` — CodeMirror setup, texture painter, three.js scene, and the
  warp shader
- `README.md` — you are here

## Running

It's three static files plus a README. Open `index.html` directly, or serve
the folder:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

Dependencies (`three`, `codemirror`, `@codemirror/lang-markdown`) are loaded
at runtime from `esm.sh`. No build step.

## Controls

- **Click** to move the caret. A `THREE.Raycaster` hits the un-warped
  plane geometry, the hit's UV is mapped back into texture pixel
  coordinates, then the renderer's per-line font logic (the same
  `measureText` walk it uses to draw the caret) figures out the
  closest line + column. Approximate near the steepest parts of the
  warp, but lands on the intended word.
- **Drag** to select. Pointer capture keeps the selection live even
  when the cursor leaves the window edge. The selected range is drawn
  on the texture as a translucent rectangle.
- **Type** markdown — headings, lists, fences, blockquotes all render.
- **Arrow keys / Home / End / Cmd-Z** — standard CodeMirror bindings.
