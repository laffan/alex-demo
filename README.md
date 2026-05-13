# Editor in 3D

A live markdown editor rendered onto a domain-warped surface in WebGL.
Click, drag, and type as if it were a normal editor; the surface bends
underneath you.

This README is a walkthrough of how the effect is put together. It
assumes you're comfortable with modern JS, the canvas 2D API, and at
least the shape of WebGL / three.js — but not necessarily fBM noise
or CodeMirror 6 internals.

---

## The big idea

Naïvely, "an editor in 3D" sounds like you'd take a DOM `<textarea>` or
CodeMirror instance and somehow rasterise its DOM into a texture every
frame. That path leads to `html2canvas`, `foreignObject`, headless
Chromium, or one of the various dom-to-texture hacks — all of which are
slow, fragile, and lossy.

The trick this demo uses is to **split the editor in two**:

```
┌──────────────────┐   document + selection   ┌───────────────────┐
│ Hidden CodeMirror│ ────────────────────────▶│ 2D canvas painter │
│   (input model)  │                          │  (visual model)   │
└──────────────────┘                          └──────────┬────────┘
        ▲                                                │
        │ keystrokes                                     │ CanvasTexture
        │ pointer events (mapped)                        ▼
        │                                     ┌───────────────────┐
        │                                     │   three.js plane  │
        └─────────────────────────────────────│   + warp shader   │
                            click/drag        └───────────────────┘
```

CodeMirror 6 is *only* used as an input/state engine — it owns the
document, the selection, the undo history, and the markdown grammar. It
never paints anything you see. A 2D canvas paints a stylised picture of
its state every frame, and *that* is the texture the GPU samples.

The payoff: the GPU sees a plain 2048×2048 RGBA texture; it has no idea
there's an editor on the other end.

---

## 1. CodeMirror 6 as a headless input

CodeMirror 6 is a stack of small ES modules. Pull them straight from a
CDN — no bundler:

```js
import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});
```

`#editor-host` is parked off-screen in CSS:

```css
#editor-host {
  position: fixed;
  top: 0;
  left: -20000px;
  width: 1200px;
  height: 1600px;
  pointer-events: none;
  opacity: 0;
}
```

Two things are worth pointing out:

- **It's still a real DOM editor.** The contenteditable element exists,
  it just lives at `left: -20000px`. That means everything CodeMirror
  does — IME, clipboard, undo/redo, autocomplete, multi-cursor — still
  works without us having to reimplement any of it. We're stealing its
  brain, not building one.
- **`pointer-events: none` matters.** If the editor host swallowed
  pointer events, our `<canvas>` would never see clicks. The canvas
  catches everything; we route input back into the editor with
  `view.focus()` and `view.dispatch(...)`.

To read state out of CodeMirror, you only need three APIs:

```js
view.state.doc                  // Text object, .lines, .line(n), .lineAt(pos)
view.state.selection.main       // { anchor, head, from, to }
view.dispatch({ selection: ... }) // imperatively move the caret
```

That's the entire contract between the editor and the painter.

---

## 2. Painting the document onto a 2D canvas

The painter is the most "ordinary" part of the demo — a single
`<canvas>` redrawn every frame. The interesting bits are the choices
that make it cheap to draw, accurate enough that hit-testing works, and
visually consistent enough with markdown's grammar to feel like a real
editor.

### Texture size and the resolution budget

```js
const TEX = 2048;
```

A square 2048×2048 texture. That's 16 MB of RGBA, uploaded to the GPU
every frame. Why this size?

- It's the largest "common" texture size still supported on basically
  every WebGL device. 4096 starts excluding older iPads / Android.
- It gives us enough horizontal resolution that 100px text doesn't
  look chunky after sampling, even when the plane is at an angle.
- The browser's "redraw a 2D canvas and re-upload as a texture" path
  is fast at this size — Chrome will keep it on the GPU and copy
  intra-VRAM if your driver is happy.

### One line at a time

CodeMirror's `state.doc` is a rope-like text structure. We iterate
logical lines:

```js
for (let i = scrollTopLine + 1; i <= doc.lines; i++) {
  const line = doc.line(i);
  const s = lineStyle(line.text);
  setFont(s);
  // ... draw selection rect, caret, then text
}
```

`lineStyle()` looks at the raw markdown source and returns a font
spec — bold for headings (heavier the smaller the `#` count), italic
for fenced ``` lines, a gutter bar for blockquotes. We keep the
markdown delimiters in the rendered text (we don't strip the `#`
characters) — that way the character index in the rendered string is
the same as the character index in the document. Cursor and selection
math just works.

### A viewport, not a paginator

The texture only shows whatever fits. Rather than scroll the rendered
text out of the canvas, we shift the **first** line we draw to keep
the caret on screen:

```js
const visibleLines = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
if (cursorLine < scrollTopLine) scrollTopLine = cursorLine;
if (cursorLine >= scrollTopLine + visibleLines)
  scrollTopLine = cursorLine - visibleLines + 1;
```

This is the same trick a terminal emulator uses: a "viewport" into a
larger document, expressed as a starting line number.

### The caret

`tctx.measureText()` is the single most useful 2D-canvas API for this
whole project. To draw the caret:

```js
const w = tctx.measureText(line.text.slice(0, cursorCol)).width;
tctx.fillRect(PADDING + w, y + 6, 6, s.size - 4);
```

That's it — measure the substring before the caret, draw a 6px-wide
white rectangle there. A `setInterval` flips a `cursorBlink` flag
every 530ms so it blinks in the OS-conventional rhythm.

### Selection ranges

Same idea, twice. For each visible line:

```js
const x1 = PADDING + tctx.measureText(line.text.slice(0, startCol)).width;
const x2 = PADDING + tctx.measureText(line.text.slice(0, endCol)).width;
const xEnd = extendsPastEol ? TEX - PADDING : Math.max(x2, x1 + 12);
tctx.fillStyle = "rgba(255,255,255,0.28)";
tctx.fillRect(x1, y + 4, xEnd - x1, s.size);
```

The `extendsPastEol` branch handles the "selection wraps onto the next
line" case — we extend the rect to the right edge of the texture so
it visually flows past the line break.

---

## 3. The CanvasTexture handoff

three.js exposes `THREE.CanvasTexture(canvas)` exactly for this
pattern. The canvas becomes a sampler the shaders can read.

```js
const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
```

Three details worth knowing:

- **`needsUpdate = true` every frame.** A `CanvasTexture` doesn't
  automatically re-upload when the source canvas changes; you have to
  tell it. We do this from the animation loop after `renderTexture()`.
- **`flipY`.** Three.js defaults `texture.flipY` to `true` for
  canvas/image sources. This is why the text isn't upside down on the
  plane: when the shader samples at `uv.y = 1`, it reads pixel
  `y = 0` (the top of the 2D canvas). It also matters for hit testing
  later — see §6.
- **Filtering.** `LinearFilter` gives soft edges where the warp
  stretches the texture. Use `NearestFilter` if you want crisp,
  pixelated text — different aesthetic, equally valid.
- **Anisotropy.** Cheap insurance against blurry text at glancing
  angles. The plane spends a lot of time near-edge-on during the warp.

We don't generate mipmaps (`generateMipmaps = false` would be the
explicit form). At 2048² with `LinearFilter`, mipmaps mostly just cost
upload bandwidth without buying us anything.

---

## 4. The plane and the warp

```js
const geometry = new THREE.PlaneGeometry(3.2, 3.2, 192, 192);
```

A `PlaneGeometry` with 192×192 subdivisions — about 37,000 vertices.
That number is a balance:

- Too few subdivisions and the warp shows as faceted polygons.
- Too many and the vertex shader becomes the frame-time bottleneck on
  integrated GPUs.

### Why displace vertices instead of warping UVs?

You can fake "warping" in the fragment shader by perturbing UVs before
sampling — it's faster and doesn't need a subdivided mesh. But you
only get the *illusion* of bending: the silhouette of the plane stays
flat, lighting doesn't change, and there's no parallax when you move
the camera. By actually moving vertices in 3D space, the plane gains a
real silhouette and the warp reads as geometry rather than a screen
effect.

### Two passes of `sin`/`cos` domain warping

The warp is deliberately small and cheap. The whole thing is one
helper and a `main`:

```glsl
vec2 warp(vec2 p, float t) {
  vec2 q = vec2(
    sin(p.y * 1.7 + t * 0.6) + cos(p.x * 1.3 - t * 0.4),
    sin(p.x * 1.9 - t * 0.5) + cos(p.y * 1.1 + t * 0.7)
  );
  vec2 r = vec2(
    sin(p.x + q.x * 1.4 + t * 0.3),
    cos(p.y + q.y * 1.4 - t * 0.2)
  );
  return r;
}
```

The shape is straight out of the "domain warping" playbook: instead of
sampling a function at `p`, sample it at `p` plus another smooth
function-of-`p`. `q` is the inner sample (each component mixing x and
y with different frequencies and time phases so they don't lock to
the same axis); `r` is the outer sample, taking `p + q` as its input.
Two passes is the sweet spot — one pass looks like a single rolling
ripple, three or more starts to look noisy and the text gets hard to
read.

A few choices worth noting:

- **Prime-ish, slow time coefficients.** `0.6`, `0.4`, `0.5`, `0.7`,
  `0.3`, `0.2` — none are equal, none are integer multiples. If they
  were, the warp would visibly cycle. Mismatched slow rates give you
  the meditative, never-quite-repeating feel.
- **Cross-axis frequencies.** Each sine takes a function of the
  *opposite* axis (`sin(p.y * ...)` in the x component). That's what
  makes the warp swirl rather than purely shear.

Then in `main()`:

```glsl
void main() {
  vUv = uv;
  vec3 pos = position;

  vec2 p = pos.xy * 1.2;
  vec2 w1 = warp(p, uTime);
  vec2 w2 = warp(p + w1, uTime * 0.7);   // warp-of-the-warp
  float h = (w1.x + w2.y) * 0.18
          + sin(pos.x * 2.3 + uTime * 0.8) * 0.06
          + cos(pos.y * 2.1 - uTime * 0.6) * 0.06;

  pos.z += h;
  vWarp = h;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
```

`w2` is the key line: we feed `w1`'s output back into `warp()`. That's
the second pass of domain warping, and it's what gives the surface its
floaty quality — straight ridges get bent, bent ridges get curled.

The two trailing `sin`/`cos` terms add a slow, low-amplitude "breath"
on top, just to make sure even the calm patches of the warp move.
Coefficients are chosen so `h` stays in roughly `[-0.5, 0.5]` — enough
displacement for the plane to feel three-dimensional, never so much
that text shears unreadably.

### Why not a full fBM domain warp?

Inigo Quilez's [Base warp fBM](https://www.shadertoy.com/view/3sfczf)
is the canonical example of the technique and was the original
reference for this demo. It stacks 4–6 octaves of `sin(x)*sin(y)`
noise (with a rotation matrix between octaves to decorrelate them) and
runs *two* warps of warps, producing the famous flowing-curtain look.

I tried porting it verbatim. It looks great as a pixel shader, but as
a *vertex* displacement field driving readable text underneath, two
things go wrong:

1. **The fBM has too much high-frequency content.** Every octave
   subdivides the surface further; the highest-frequency octave ends
   up the size of a glyph, and the text shears at every ridge.
2. **It's expensive per-vertex.** ~20 noise evaluations × 37,000
   vertices is fine on a discrete GPU but visibly drops frames on
   integrated graphics.

The two-pass `sin`/`cos` warp above is the low-frequency, low-cost
sibling: same domain-warping concept, but tuned so the entire texture
is one or two slow swells across the whole plane, not a field of
peaks. The text rides the warp instead of fighting it.

If you want the IQ aesthetic, it's still a great fit for a pure
fragment-shader background — just not behind a text editor.

---

## 5. The fragment shader

```glsl
void main() {
  vec3 col = texture2D(uTex, vUv).rgb;
  float l = dot(col, vec3(0.299, 0.587, 0.114));   // luminance
  float v = smoothstep(0.95, 0.15, length(vUv - 0.5));
  l *= 0.55 + 0.45 * v;                            // soft vignette
  l *= 1.0 + vWarp * 1.2;                          // ridges brighter
  gl_FragColor = vec4(vec3(l), 1.0);
}
```

The interesting line is `l *= 1.0 + vWarp * 1.2`. Because `vWarp` is
the per-vertex displacement linearly interpolated across the fragment,
the high points of the surface get brightened and the low points
darkened. This isn't physically correct lighting — there are no
normals, no light position — but the human eye reads "varying
brightness along a varying height" as shading. It's the cheapest
possible way to make the warp feel three-dimensional rather than
flat-projected.

The luminance conversion + multiply-only operations guarantee the
output stays grayscale, which is the look we want.

---

## 6. Click and drag in 3D

This is the part most "DOM editor in WebGL" demos punt on. To support
clicking a specific character on the warped surface, we need to
invert the entire pipeline:

```
screen pixel → ray → mesh hit → UV → texture pixel → line + column → doc position
```

### Raycasting against the plane

```js
const raycaster = new THREE.Raycaster();
ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
raycaster.setFromCamera(ndc, camera);
const hits = raycaster.intersectObject(mesh);
```

Important: three.js's `Raycaster` hits the **CPU-side** geometry. Our
warp lives only in the vertex shader, on the GPU — the JS-side
geometry is still the original flat plane. So we're raycasting the
flat, un-warped plane sitting in space, not the bumpy surface the user
sees. The user said "approximate is fine," which is good, because this
is approximate near the steep parts of the warp. The fix, if you ever
want pixel-perfect hits, is to run `baseWarp` on the CPU too and
ray-march the heightfield — straightforward but a noticeable amount of
extra code.

### UV → texture pixel

```js
const uv = hits[0].uv;
const px = uv.x * TEX;
const py = (1 - uv.y) * TEX;       // remember flipY
```

`hits[0].uv` is already the interpolated UV at the intersection
point — three.js does the work for us. We multiply by texture size to
get pixel coordinates. The `1 - uv.y` is the `flipY` accounting:
since the GPU samples a top-flipped texture, our painter's y=0 (top)
corresponds to uv.y=1.

### Texture pixel → line + column

For the line, it's pure division:

```js
const row = Math.floor((py - PADDING) / LINE_HEIGHT);
const lineNumber = clamp(scrollTopLine + 1 + row, 1, doc.lines);
```

`scrollTopLine` is the same viewport offset the painter used.

For the column, we reuse the painter's per-line font logic so the math
stays consistent:

```js
setFont(lineStyle(line.text));
const targetX = Math.max(0, px - PADDING);
let col = line.text.length;
let prevW = 0;
for (let i = 1; i <= line.text.length; i++) {
  const w = tctx.measureText(line.text.slice(0, i)).width;
  if (targetX < (prevW + w) / 2) { col = i - 1; break; }
  prevW = w;
}
```

The `(prevW + w) / 2` is the midpoint between the left and right
edges of the i-th glyph — the standard "snap to whichever side of the
character you clicked on" behaviour all text editors use.

This is O(n²) in the line length (each `measureText` call walks the
substring) and could be O(n) by stepping one glyph at a time. For
demo-sized lines it doesn't matter; for novel-sized lines you'd want
to cache cumulative widths.

### Dispatching back into CodeMirror

```js
view.dispatch({ selection: { anchor: pos, head: pos } });
```

That's the entire act of moving the caret. `pos` is an absolute
document offset; `line.from + col` produces it.

### Drag selection

The drag implementation is conventional pointer-capture state:

```js
stageEl.addEventListener("pointerdown", (e) => {
  const pos = docPosFromPointer(e);
  if (pos !== null) {
    dragAnchor = pos;
    dragging = true;
    stageEl.setPointerCapture(e.pointerId);
    view.dispatch({ selection: { anchor: pos, head: pos } });
  }
  view.focus();
});

stageEl.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const pos = docPosFromPointer(e);
  if (pos !== null) view.dispatch({ selection: { anchor: dragAnchor, head: pos } });
});
```

`setPointerCapture` is the unsung hero. It guarantees pointermove
events keep arriving even when the cursor leaves the window, so a
drag that goes off the edge doesn't end abruptly.

---

## 7. Things you'd extend next

This demo stops at "good enough to feel real." A short list of where
to go from here:

- **CPU-side displacement for accurate hit testing.** Run `baseWarp`
  in JS and either ray-march the heightfield or update a copy of the
  geometry's positions each frame; raycast against that. The shader
  becomes the source of truth for both rendering and hit-testing.
- **Wrapped lines.** CodeMirror handles wrapping; the painter
  doesn't. To match, either enable `EditorView.lineWrapping` and ask
  CodeMirror for its visual line layout, or implement greedy wrapping
  in the painter with the same line height.
- **Syntax-aware highlighting.** Right now we regex-match the first
  characters of each line. CodeMirror exposes a syntax tree via
  `syntaxTree(view.state)` you can walk to highlight `**bold**` runs,
  inline `code`, links, etc.
- **Real lighting.** Compute a normal from the warp's analytical
  derivatives (or via screen-space derivatives in the fragment
  shader) and do a basic Lambert. The "ridges brighter" trick will
  start to feel cheap once everything else is real.
- **Multi-cursor.** CodeMirror supports it natively
  (`state.selection.ranges`); the painter only renders
  `selection.main`.

---

## Files

- `index.html` — mounts the WebGL canvas (`#stage`) and the hidden
  editor host (`#editor-host`)
- `styles.css` — full-screen black; parks the editor off-screen
- `script.js` — CodeMirror setup, the 2D painter, the three.js scene,
  the warp shader, and the click/drag hit testing
- `README.md` — this file

## Running

Three static files plus a README. Open `index.html` directly, or:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

Dependencies (`three`, `codemirror`, `@codemirror/lang-markdown`) load
at runtime from `esm.sh`. No build step, no `node_modules`.

## Controls

- **Click** to place the caret.
- **Drag** to select.
- **Type** markdown — headings, code fences, blockquotes all style.
- **Arrow keys / Home / End / Cmd-Z** — standard CodeMirror bindings.
