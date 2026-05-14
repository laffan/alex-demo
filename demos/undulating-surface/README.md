# Editor in 3D

A live markdown editor rendered onto a domain-warped surface in WebGL.
Dark brown letters in Trocchi on a light tan ground, bending in slow
swells. Click, drag, and type as if it were a normal editor; the
surface bends underneath you.

This README is a walkthrough of how the effect is put together. It
assumes you're comfortable with modern JS, the canvas 2D API, and at
least the shape of WebGL / three.js — but not necessarily CodeMirror 6
internals or domain warping.

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

`#editor-host` is rendered on-screen at full size, but covered by the
WebGL canvas via z-index:

```css
#stage       { position: fixed; inset: 0; z-index: 1; }
#editor-host {
  position: fixed;
  top: 0;
  left: 0;
  width: 1200px;
  height: 1600px;
  pointer-events: none;
  z-index: 0;
}
```

Three things are worth pointing out:

- **It's still a real DOM editor.** The contenteditable element exists
  inside `#editor-host`. That means everything CodeMirror does — IME,
  clipboard, undo/redo, autocomplete, multi-cursor — still works
  without us having to reimplement any of it. We're stealing its
  brain, not building one.
- **`pointer-events: none` matters.** If the editor host swallowed
  pointer events, our `<canvas>` would never see clicks. The canvas
  catches everything; we route input back into the editor with
  `view.focus()` and `view.dispatch(...)`.
- **Hide it with z-index, not `opacity` or off-screen positioning.**
  This is the part that bit me on Firefox. Chrome and Safari will
  cheerfully send keystrokes to a contenteditable element no matter
  how invisible it is — they only refuse on `display: none` and
  `visibility: hidden`. Firefox is stricter: in practice it treats
  `opacity: 0` (and elements positioned entirely outside the viewport)
  as "not really there" for keyboard input, so `view.focus()` succeeds
  but key events never arrive at CodeMirror's handler. Keeping the
  element fully rendered and in-viewport, and just covering it with
  the opaque canvas, sidesteps the whole class of issue.

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

### Font and palette

Body text is Trocchi at 100px, loaded from Google Fonts. Trocchi is a
slabby serif with a single regular weight — for our markdown headings
we just ask canvas for `font-weight: 700` and accept faux-bold; for
fenced ``` lines we ask for italic and accept faux-italic. At 100px
those synthetic styles read fine.

```js
const FONT_FAMILY = '"Trocchi", Georgia, serif';
// ... near the bottom of script.js:
document.fonts.load(`${FONT_SIZE}px "Trocchi"`).then(tick);
```

That last line is the gotcha. If you start the animation loop
immediately, the first second or so of frames render in the fallback
serif (Georgia) — then the real font pops in, every `measureText`
suddenly returns different widths, and the caret jumps. The
[CSS Font Loading API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Font_Loading_API)
gives us a promise that resolves once Trocchi is actually ready;
we wait on that before kicking off `requestAnimationFrame`.

The colour palette is a deliberate two-tone:

```js
const BG_HEX = "#efe5cb";   // very light tan
const FG_HEX = "#1f1209";   // nearly black, warm brown
```

— used for the texture background, the text, the caret, the selection
overlay, *and* the three.js scene clear colour. The plane and the
empty space around it share a colour, so only the warp's pseudo-light
and the faint border tell you where the page ends and the room
begins.

### Wrapped layout

The Alice text is a single ~300-character logical line. Without
wrapping, it would shoot off the right edge of the texture in the
first row. The painter does a greedy word-wrap pass each frame to
break each logical line into one or more *visual rows*:

```js
function wrapText(text, maxWidth) {
  const tokens = text.match(/\s+|\S+/g) || [];
  const segs = [];
  let segStart = 0, segText = "", pos = 0;
  for (const tok of tokens) {
    const test = segText + tok;
    if (tctx.measureText(test).width > maxWidth && segText.length > 0) {
      segs.push({ text: segText, startCol: segStart });
      segStart = pos;
      segText = tok;
    } else {
      segText = test;
    }
    pos += tok.length;
  }
  segs.push({ text: segText, startCol: segStart });
  return segs;
}
```

Two design choices worth pointing out:

- **Tokenize into `\s+|\S+` runs.** Each token is either pure
  whitespace or pure non-whitespace. Breaks are only allowed *between*
  tokens, which is exactly the standard word-wrap rule. Trailing
  spaces stay attached to the row they belong to, so clicking on a
  trailing space resolves to the right column.
- **Track `startCol` per segment.** Each visual row remembers the
  logical-line column at which it starts. That single integer lets
  every downstream operation (caret rendering, selection rendering,
  hit testing, viewport scrolling) translate freely between visual
  rows and CodeMirror document positions, without keeping a separate
  bidirectional index.

`computeLayout()` runs `wrapText` on every logical line and produces a
flat list of visual rows:

```js
rows.push({
  text: seg.text,
  startDocPos: line.from + seg.startCol,
  endDocPos:   line.from + seg.startCol + seg.text.length,
  style,
  isFirstInLine: i === 0,
  isLastInLine:  i === segs.length - 1,
});
```

Once you have `startDocPos` / `endDocPos` per row, everything else
falls out of it.

`lineStyle()` looks at the raw markdown source of each logical line
and returns a font spec — heavier weight for headings (more so the
smaller the `#` count), italic for fenced ``` lines, a gutter bar for
blockquotes. We keep the markdown delimiters in the rendered text (we
don't strip the `#` characters) — that way the character index in the
rendered string is the same as the character index in the document.

### A viewport, in visual rows

Once wrapping is in the picture, the viewport has to be expressed in
visual rows, not logical lines — one CodeMirror line can wrap to a
dozen rows, and the user expects to scroll through them one at a time.

```js
const cursorRowIdx = findCursorRow(visualRows, head);
const visibleRowCount = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
if (cursorRowIdx < scrollTopRow) scrollTopRow = cursorRowIdx;
if (cursorRowIdx >= scrollTopRow + visibleRowCount)
  scrollTopRow = cursorRowIdx - visibleRowCount + 1;
```

`findCursorRow` does one subtlety worth mentioning. When the caret
sits exactly on a wrap break (e.g. cursor at column 30, the row above
ends at column 30 with a trailing space, the row below starts at
column 30), it has to pick *one* row to draw on. We pick the
last-matching row — so a cursor on a wrap boundary is rendered at the
start of the next visual row, where the next typed character will
actually appear. Same convention every editor uses.

### The caret

`tctx.measureText()` is the single most useful 2D-canvas API for this
whole project. The caret is a terminal-style **block cursor**:

```js
const localCol = head - row.startDocPos;
const wBefore = tctx.measureText(row.text.slice(0, localCol)).width;
const cursorChar = localCol < row.text.length ? row.text[localCol] : "";
const blockWidth = cursorChar
  ? tctx.measureText(cursorChar).width
  : tctx.measureText("M").width * 0.55;        // end-of-row fallback

tctx.fillStyle = FG_HEX;
tctx.fillRect(PADDING + wBefore, y + 6, blockWidth, s.size - 4);
if (cursorChar) {
  tctx.fillStyle = BG_HEX;
  tctx.fillText(cursorChar, PADDING + wBefore, baseline);
}
```

Three things to notice:

- **The block width matches the glyph under it.** We measure the
  character at the caret's position so the block is exactly as wide
  as the letter it covers — narrow on an `i`, fat on an `m`. At the
  end of a row (or at end-of-doc) there's no character to measure,
  so we fall back to about half an em.
- **The character under the block gets redrawn inverted.** The
  regular `fillText(row.text, ...)` call has already painted the
  whole row in the foreground colour. Drawing a foreground-coloured
  block on top covers that letter; drawing it again in the background
  colour at the same position gives the classic inverted-glyph block
  cursor effect.
- **It still blinks.** A `setInterval` flips a `cursorBlink` flag
  every 530ms. When the flag is off, the block isn't drawn at all,
  and the original letter (drawn in the regular `fillText` pass
  earlier) shows through.

### Selection ranges

Same idea, applied per visual row. For each row that overlaps
`[selFrom, selTo]`:

```js
const startCol = Math.max(0, selFrom - row.startDocPos);
const endCol   = Math.min(row.text.length, selTo - row.startDocPos);
const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
const extendsPastRow = selTo > row.endDocPos;
const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 12);
tctx.fillStyle = SELECTION_RGBA;
tctx.fillRect(x1, y + 4, xEnd - x1, s.size);
```

The `extendsPastRow` branch handles the "selection continues onto the
next row" case — we extend the rect to the right edge of the texture
so the highlight visually flows past the wrap break and across the
gap to the next row's start. The minimum width (`x1 + 12`) is so an
empty-line selection still gets a visible sliver.

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

  float v = smoothstep(0.95, 0.15, length(vUv - 0.5));
  col *= 0.82 + 0.18 * v;                          // soft vignette

  col = clamp(col * (1.0 + vWarp * 0.55), 0.0, 1.0); // ridges/troughs
  gl_FragColor = vec4(col, 1.0);
}
```

This is deliberately a *colour-preserving* shader — we never convert
to luminance — because the whole effect depends on keeping the tan
and brown coming through cleanly. Two passes do the work:

- **The vignette** multiplies down toward `col * 0.82` at the edges
  of the plane (where `v = 0`), keeping the centre near `col * 1.0`
  (`v = 1`). On the tan body this reads as the corners falling into
  shadow; on the dark text it does nothing visible. The `0.82 +
  0.18 * v` formulation guarantees we never multiply *up*, so we
  can't blow out the tan into white.
- **`1.0 + vWarp * 0.55`** is the cheap pseudo-lighting trick.
  `vWarp` is the per-vertex displacement, linearly interpolated
  across the fragment, so high points of the surface get a multiplier
  above 1 and low points get a multiplier below 1. There are no
  normals, no light position — but the eye reads "brighter where
  geometry is closer" as shading, and the surface gains a strong
  sense of three-dimensionality for one multiply per pixel. The
  `clamp` keeps the tan from blowing past white in the brightest
  ridge crests.

The two operations are intentionally subtle on the text (which is
already near-zero in all channels, so multiplying by 0.82 or 1.5
both round to "still very dark brown") and prominent on the tan body
(where the multipliers shift it through visible swathes of light and
deeper tan). The legibility budget stays intact.

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

### Texture pixel → row → column

Because the painter already built a flat list of `visualRows` this
frame (with each row knowing its `startDocPos`), we don't have to
think about logical lines at all here:

```js
const rowIdx = clamp(scrollTopRow + Math.floor((py - PADDING) / LINE_HEIGHT),
                     0, visualRows.length - 1);
const row = visualRows[rowIdx];
```

That's it for "which row." For the column within that row, we reuse
the painter's per-row font logic (`setFont(row.style)`) so the
measurements match exactly what was drawn:

```js
setFont(row.style);
const targetX = Math.max(0, px - PADDING);
let col = row.text.length;
let prevW = 0;
for (let i = 1; i <= row.text.length; i++) {
  const w = tctx.measureText(row.text.slice(0, i)).width;
  if (targetX < (prevW + w) / 2) { col = i - 1; break; }
  prevW = w;
}
```

The `(prevW + w) / 2` is the midpoint between the left and right
edges of the i-th glyph — the standard "snap to whichever side of the
character you clicked on" behaviour all text editors use.

This is O(n²) in the row length (each `measureText` call walks the
substring) and could be O(n) by stepping one glyph at a time. For
demo-sized rows it doesn't matter; for novel-sized rows you'd want
to cache cumulative widths.

### Dispatching back into CodeMirror

```js
const pos = row.startDocPos + col;
view.dispatch({ selection: { anchor: pos, head: pos } });
```

That's the entire act of moving the caret. The `startDocPos` we
stashed on every row earlier is exactly the bridge from visual
coordinates back to CodeMirror's flat document offsets — no extra
mapping table required.

### Drag selection (and the focus dance that makes it work)

The drag itself is conventional pointer-capture state — `pointerdown`
sets an anchor and a collapsed selection, `pointermove` extends the
head, `pointerup` ends it. `setPointerCapture` is the unsung hero
here: it guarantees pointermove events keep arriving even when the
cursor leaves the window, so a drag that goes off the edge doesn't
end abruptly.

The non-obvious part is *focus and DOM selection synchronisation*.
The first version of this demo had a subtle bug: drag a selection,
press Delete, and only one character got deleted — as if the
selection wasn't there at all, even though the painter had clearly
drawn it. Three things go wrong if you don't actively manage focus:

1. **`mousedown` on the canvas runs its default action.** Among other
   things, the browser will collapse any active text selection on the
   page. The contenteditable inside `#editor-host` is hidden but
   technically a normal text element, and its DOM `Selection` is
   subject to the same rules. By the time we dispatch our drag
   selection, the underlying DOM Selection has just been collapsed.
2. **CodeMirror's DOM selection sync is conditional on focus.** When
   you call `view.dispatch({ selection })`, CodeMirror updates
   `state.selection` immediately and tries to update the contenteditable's
   DOM Selection to match. But if focus has wandered (or never arrived
   at) the editor, the DOM Selection update can no-op.
3. **CodeMirror's `selectionchange` handler reads from the DOM.** On
   the next user key event, CodeMirror checks whether the DOM
   Selection matches `state.selection`. If they disagree, it can
   "correct" `state.selection` to match what's actually in the DOM —
   which, in our broken case, is a collapsed cursor. The keymap then
   sees a collapsed selection and Delete eats just one character.

Four small changes fix the whole chain:

```js
stageEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();              // 1
  view.focus();                    // 2
  const pos = docPosFromPointer(e);
  if (pos === null) return;
  dragAnchor = pos;
  dragging = true;
  stageEl.setPointerCapture(e.pointerId);
  view.dispatch({                  // 3
    selection: { anchor: pos, head: pos },
    userEvent: "select.pointer",
  });
});

// pointerup:
view.focus();                      // 4
```

1. **`preventDefault()` on `pointerdown`** stops the browser's default
   mousedown side effects — no selection collapse, no focus change.
   In the pointer events model, this also suppresses the synthetic
   mousedown that would otherwise follow.
2. **`view.focus()` before any dispatch** guarantees CodeMirror owns
   focus by the time we ask it to update its selection, so the DOM
   Selection sync actually runs.
3. **`userEvent: "select.pointer"`** tags the transaction so anything
   CodeMirror does (history grouping, plugins listening for
   selection changes) treats it as a user-initiated drag rather than
   a programmatic poke.
4. **`view.focus()` again on `pointerup`** re-asserts the DOM
   Selection sync after the drag ends, so the very next keystroke
   sees the range we drew.

The canvas's `tabindex` attribute is also gone (it was `0` originally
to make the canvas focusable for click-to-type). Without it, a click
on the canvas can't accidentally pull focus off the editor in the
first place, which is one less thing for the focus dance to recover
from.

---

## 7. Things you'd extend next

This demo stops at "good enough to feel real." A short list of where
to go from here:

- **CPU-side displacement for accurate hit testing.** Run the same
  `warp()` function in JS and either ray-march the heightfield or
  update a copy of the geometry's positions each frame; raycast
  against that. The shader becomes the source of truth for both
  rendering and hit-testing.
- **Syntax-aware highlighting.** Right now we regex-match the first
  characters of each line. CodeMirror exposes a syntax tree via
  `syntaxTree(view.state)` you can walk to highlight `**bold**` runs,
  inline `code`, links, etc. — would also let you assign per-token
  colours (a darker brown for emphasis, a sepia for code) without
  much extra code.
- **Real lighting.** Compute a normal from the warp's analytical
  derivatives (or via screen-space derivatives in the fragment
  shader) and do a basic Lambert. The "ridges brighter" trick will
  start to feel cheap once everything else is real.
- **Smarter wrap.** The wrap is greedy and word-based; long
  unbreakable tokens (a URL, a path with no spaces) will overflow.
  Knuth–Plass-style penalty wrapping or character-level fallback
  would handle them.
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
