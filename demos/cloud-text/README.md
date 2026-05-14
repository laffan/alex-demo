# Writing in clouds

A live editor rendered as a thin volumetric slab of smoke. The glyphs
glow from inside a noise-warped fog; type, click, drag, and the cloud
re-forms around the new shape of the document.

This is demo #02 in the series. It shares the editor scaffolding with
[`../undulating-surface/`](../undulating-surface/) — a hidden
CodeMirror instance owns input, a 2D canvas rasterises a stylised
picture of its state every frame, and a single WebGL pass turns that
picture into something the user actually sees. The bit that changes
between demos is only the last step.

---

## The picture in one sentence

> A full-screen quad whose fragment shader raymarches a Z-aligned slab
> of 3D fbm noise, using the editor's text canvas as the density field
> at z = 0.

That's the whole trick. Everything else is parameter tuning.

---

## 1. The atlas: thick glyphs, two channels

The texture canvas is a 2048×2048 black field with the document
painted on top. Compared to demo #01 the differences are small but
deliberate:

- **Archivo Black at 900 weight.** Volumetric rendering eats thin
  shapes — a hairline serif would dissolve into the noise long before
  it became legible. A heavy display sans gives the shader enough
  density to chew on.
- **White text on black, not brown on tan.** The atlas is being read
  as a density field, not a colour map. The red channel goes straight
  into the volume integral; anything that isn't glyph should be zero.
- **Selection painted blue, not as a translucent overlay.** The
  fragment shader splits channels: `r` drives glyph density, `b − r`
  recovers a selection mask, and that mask gets its own (cooler,
  brighter) emission colour. So a highlight isn't a separate layer —
  it's a region of the same volume that happens to glow blue.
- **The cursor is painted in the same atlas** as a small bright
  rectangle in cyan. The shader doesn't know it's a cursor; it just
  treats it as a particularly bright local density and lets it glow.

All the wrapping, scrolling, markdown styling, and hit-test
bookkeeping are exactly the same as in demo #01 — the `visualRows`
table is the lingua franca that maps between document coordinates and
texture pixels for both rendering and click handling.

---

## 2. The volumetric pass

The geometry is dead simple: a single `PlaneGeometry(3.4, 3.4, 1, 1)`.
No tessellation, no displacement, no surface at all. All the depth
the user perceives is conjured per-pixel in the fragment shader.

For each fragment we march `N=32` evenly-spaced samples along a thin
slab in z. At each sample point we evaluate three things:

1. **Where in the atlas to look** — start from the fragment's UV,
   offset by a per-slice noise displacement whose magnitude grows
   with `|z|`. The slab's centre sits exactly on the painted glyphs;
   the front and back of the slab fray outward.
2. **How dense the volume is here** — multiply the glyph mask by a
   Gaussian window in z (`exp(-z² · 11)`), then modulate by 3D fbm so
   the inside of every glyph billows and roils instead of looking
   like a flat sheet.
3. **What colour it emits** — a warm cream for normal text, a cooler
   blue for selected text. A one-tap secondary noise sample along the
   light direction stands in for a full shadow march, just enough to
   keep the cloud from looking uniformly lit.

The accumulator does a textbook front-to-back composite with
Beer-Lambert transmittance:

```
emit  += trans · sliceEmit · dens · dz · K_emit
trans *= exp(-dens · dz · K_extinct)
```

Trans starts at 1 and decays as we move through dense regions, so the
nearer parts of a glyph occlude what's behind them. With an early-out
at `trans < 0.01` the shader rarely takes more than a dozen steps per
pixel inside a thick glyph, and zero on the empty sky outside.

A couple of small touches sit on top of the integral:

- A faint **drifting sky** behind the volume — a single fbm sample
  shaded between two dark blue-greys — so the canvas isn't dead black
  outside the text.
- A **per-pixel parallax**: the slab's UV at each slice is offset by
  a ray-direction term derived from the fragment's NDC, so the front
  of a glyph sits visibly forward of the back of the same glyph.
  Cheap, sells volume.
- **Reinhard tone mapping** (`col / (col + 0.85)`) so the brightest
  cores roll off into highlights instead of clipping flat.
- A hash-based **grain** of ±0.0125 so the dark regions have life and
  the volumetric banding from only 32 steps stops being visible.

The 3D fbm is built on a tiny `hash13 → vnoise` pair — three lines of
mix-of-mixes value noise, five octaves. No textures, no precomputed
permutation table; the GPU is fast enough that procedural beats the
texture lookup in this regime.

---

## 3. Why a single quad, not real geometry

You could imagine the cloud as a stack of textured planes
(impostor-style), or as a real low-resolution volume texture, or as
particle billboards. All of those work, and all of them lose what
this demo has: the editor's *live* texture maps one-to-one into the
volume, every frame, with no upload step beyond the existing
`CanvasTexture` blit. Re-rasterising the atlas every frame is already
cheap; spending the GPU on a fragment-side raymarch instead of CPU
geometry keeps the latency from keystroke to visible cloud at one
frame.

---

## 4. Hit testing

A flat quad with identity UV → atlas coordinates → row/col is the
simplest possible hit test, and it's exactly what this demo uses. The
raycaster intersects the (visually invisible, geometrically still
there) quad; the resulting `uv` is converted to texture pixels and
then to a document position by walking `visualRows` and binary-style
measuring against `tctx.measureText`. The fact that the cloud appears
"in front of" the quad doesn't matter — clicks are aimed at the
underlying flat shape, which is exactly where the glyphs sit in the
atlas.

The pointer-event dance (pre-`pointerdown` focus + `preventDefault`,
re-focus on `pointerup`) is identical to demo #01. See its README for
the painful Firefox details.

---

## 5. Knobs

If you want to play, the most expressive numbers live in the fragment
shader:

| What | Where | Effect |
| ---- | ----- | ------ |
| `STEPS` | `for (int s = 0; s < STEPS; s++)` | Quality vs. cost. 24 is grainy, 48 is butter. 32 is the default. |
| `zNear` / `zFar` | top of the loop | Slab thickness. Wider = blurrier, deeper-looking glyphs. |
| `exp(-z * z * 11.0)` | density window | The `11` controls how tightly density hugs z=0. Smaller = thicker clouds. |
| `(0.045 + 0.085 * abs(z))` | UV warp magnitude | How frayed glyph edges get along z. |
| `K_emit` (the `* 3.6`) and `K_extinct` (the `* 5.5`) | accumulator | Brightness vs. occlusion. Push emit up and clouds glow; push extinct up and they shadow themselves more. |
| `vec3 textCol` / `vec3 selCol` | inside the loop | Glyph and selection colours, before tone mapping. |

The 3D-fbm reference at
<https://discourse.threejs.org/t/efficient-volumetric-clouds/66067/2>
is worth a read for context on the raymarch shape, even though this
demo is using value noise rather than the linked Worley setup —
glyphs are a small enough density support that the cheaper noise is
already enough.

---

## Files

- `index.html` — mounts the WebGL canvas and the hidden editor host.
- `styles.css` — full-screen dark; parks the editor host behind the
  canvas.
- `script.js` — CodeMirror setup, the atlas painter, the three.js
  scene, the volumetric raymarch shader, and the pointer hit testing.
- `README.md` — this file.

## Running

Open `index.html` directly, or serve the repo root with
`python3 -m http.server`. No build step; `three` and CodeMirror load
at runtime from `esm.sh`.

## Controls

- **Click** to place the caret.
- **Drag** to select.
- **Type** — markdown headings and blockquotes pick up extra weight.
