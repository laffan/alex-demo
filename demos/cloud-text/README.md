# Writing in clouds

A live editor rendered as a thin volumetric slab of smoke. The
glyphs glow from inside a noise-warped fog; type, click, drag, and
the cloud re-forms around the new shape of the document. The camera
floats with the caret, so the text you're working on stays roughly
centred under your eye.

This is demo #02 in the series. It shares the editor scaffolding
with [`../undulating-surface/`](../undulating-surface/) — a hidden
CodeMirror instance owns input, a 2D canvas rasterises a stylised
picture of its state every frame, and a single WebGL pass turns
that picture into something the user actually sees. The bit that
changes between demos is only the last step.

---

## The picture in one sentence

> A full-screen quad whose fragment shader raymarches a thin
> Z-aligned slab — but only after a 5-tap pre-check confirms there
> *is* text in this fragment's neighbourhood; on empty sky pixels
> we exit before the loop even starts.

The first version of this demo did the textbook "fat raymarch every
pixel" thing — 32 steps, 5-octave fbm, a per-step shadow tap — and
it ground to a crawl on anything but a small window. The current
version applies three of the optimisations
[Maxime Heckel writes about](https://blog.maximeheckel.com/posts/real-time-cloudscapes-with-volumetric-raymarching/):

1. **Empty space skipping** via a cheap density probe.
2. **Fewer, smarter steps** — 12 instead of 32, with an early-out
   when transmittance gets low enough.
3. **2D fbm with z baked into translation**, not a true 3D fbm —
   visually identical on a slab this thin, ~half the noise cost.

The result is fast enough that the camera can sit close to giant
glyphs and still hit framerate.

---

## 1. The atlas: huge glyphs, two channels

The texture canvas is a 3072² black field with the document
painted in three colours:

- **White `#ffffff`** for glyphs.
- **Blue `#6a86ff`** for selection rectangles.
- **Cyan `#aeefff`** for the cursor block.

The shader recovers each as a separate density via channel
arithmetic: glyph density is the red channel, selection density is
`b − r * 0.6` clamped, cursor and glyph share the bright path.

`FONT_SIZE` is 280 — much bigger than demo #01 — because the
camera is zoomed in tightly and small glyphs would dissolve into
noise before they became readable. Archivo Black at 900 weight
gives the shader thick, fat strokes that survive the warp.

---

## 2. The camera follows the cursor

The fragment shader reads two new uniforms:

```glsl
uniform vec2 uOrigin;     // atlas UV the camera is centred on
uniform vec2 uViewSize;   // fraction of atlas the screen shows
```

and computes its atlas lookup as:

```glsl
vec2 atlasUv = uOrigin + (vUv - 0.5) * uViewSize;
```

So `uOrigin = (0.5, 0.5)` shows the centre of the atlas;
`uViewSize.y = 0.42` means the screen height covers 42% of the
atlas height. The aspect-corrected `uViewSize.x` widens with the
window.

On the JS side we track the cursor's pixel position in the atlas
(updated inside the texture-paint pass) and lerp `uOrigin` toward
it every frame:

```js
const t = targetOrigin();    // cursor UV, clamped to atlas
clampOrigin(t);
camOrigin.lerp(t, 0.12);     // not exact — gives the camera lag
```

The `0.12` factor is the only tuning knob: low enough that arrow-
key sweeps glide rather than jump, high enough that the camera
keeps up with sustained typing. The clamp guarantees the visible
window stays inside the atlas, so the edges never reveal blank
canvas.

A side effect of camera-follow: the cursor's atlas position is
*always* recorded, even on the blink-off frames where the bright
cyan cursor block isn't being painted. Without that, the camera
would pulse with the blink — visually awful. Recording the position
unconditionally and only gating the *paint* on `cursorBlink` keeps
the camera glued to the caret regardless.

---

## 3. The volumetric pass, lean version

For each fragment, the shader does:

1. **Pan + zoom** the screen UV into the atlas.
2. **Pre-check** with `densityProbe(atlasUv)`: a 5-tap lookup at
   the centre and four ±0.045 offsets. The max of all `r` and `b`
   channels is taken as a "is anything text-like nearby?" signal.
   If it's below ~0.02, the fragment is pure sky — output the
   gradient and exit. This is the optimisation that makes the demo
   actually playable.
3. If the pre-check passes, **march 12 steps** through a thin slab
   in z. At each step:
   - Sample 2D fbm (2 octaves) with z and time baked into
     translation. Cheap.
   - UV-warp the atlas lookup by the noise vector, scaled by
     `(0.020 + 0.060 * |z|)` so glyph fronts/backs fray.
   - Compute density from glyph mask × Gaussian z-window × noise
     modulation.
   - Pick a slice colour (warm cream for text, cool blue for
     selection); apply a cheap depth-driven brightness lerp instead
     of a real shadow tap.
4. **Composite** with Beer-Lambert transmittance, with an early-
   out when `trans < 0.02`.
5. **Tone-map** with `col / (col + 0.85)` so the bright cores roll
   off into highlights.

No 3D noise, no secondary rays, no normal estimation. The
"volumetric" feel comes from accumulating warped 2D samples along
a thin slab with proper transmittance, which is enough at this
scale.

---

## 4. Hit testing under the pan/zoom

Click handling has to undo the same `uOrigin + (vUv - 0.5) *
uViewSize` transform the shader applied:

```js
const sx = event.clientX / window.innerWidth;
const sy = 1 - event.clientY / window.innerHeight;
const atlasU = camOrigin.x + (sx - 0.5) * viewSize.x;
const atlasV = camOrigin.y + (sy - 0.5) * viewSize.y;
```

then convert atlas UV → atlas pixels → row/col by walking
`visualRows` and measuring with `tctx.measureText` — exactly the
same routine as the other demos. There's no raycaster anymore (no
3D mesh to hit), just direct math against the screen and the known
camera state.

---

## 5. Knobs

| What | Where | Effect |
| ---- | ----- | ------ |
| `STEPS` | inside the march | Quality vs. cost. 12 is the default; 16 is silkier. |
| `0.02` in `if (probe < 0.02)` | early-out threshold | Lower = more conservative skip; higher = more pixels marked sky. |
| `0.045` in `densityProbe` | probe radius | Has to cover the worst-case warp magnitude. |
| `(0.020 + 0.060 * abs(z))` | UV warp magnitude | How frayed glyph edges get. |
| `baseH` in `updateViewSize` | `0.42` | Camera zoom. Smaller = closer. |
| Lerp factor `0.12` in `tick()` | camera follow | How "sticky" the camera is to the caret. |

---

## Files

- `index.html` — mounts the WebGL canvas and the hidden editor host.
- `styles.css` — full-screen dark; parks the editor host behind the
  canvas.
- `script.js` — CodeMirror setup, the atlas painter, the orthographic
  full-screen quad, the lean volumetric shader, the camera-follow
  loop, and the pointer hit testing.
- `README.md` — this file.

## Running

Open `index.html` directly, or serve the repo root with
`python3 -m http.server`. `three` and CodeMirror load at runtime
from `esm.sh`; Archivo Black loads from Google Fonts.

## Controls

- **Click** to place the caret.
- **Drag** to select.
- **Type** — the camera glides to follow you.
