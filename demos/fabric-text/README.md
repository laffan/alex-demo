# Under the fabric

A live editor rendered as a thin sheet of cloth stretched over the
text. The letters are *geometry* — small ridges pushing up against
the fabric from below — and the fabric drapes over them, revealing
their shape only through how raking light catches the ridges and
shadow falls behind. White (the high points) on off-white (the
flat).

This is demo #04 in the series. Same hidden-CodeMirror /
2D-canvas / WebGL-overlay pattern as the rest — see the
[undulating-surface README](../undulating-surface/) for the bones
of that architecture.

---

## The picture in one sentence

> A high-subdivision plane displaced in z by a Gaussian-blurred
> sample of the editor's text canvas (read as a height field), with
> the fragment shader recovering normals from screen-space
> derivatives of world position and shading the surface with raking
> light to read as cloth.

No colour anywhere. The letters never get painted; they exist only
as raised ridges in a single off-white surface.

---

## 1. The atlas is a height field

The text canvas is painted with three flat tones, but they're not
colours — they're *heights*:

- **White `#ffffff`** for glyphs and the cursor block — full lift.
- **50% white** for the rectangle behind a selection — half lift.
- **Black** for the rest — flat fabric.

The shader only ever reads `texture2D(uTex, uv).r`. That's the
height map. Selection comes out as a gentle plateau the letters
sit on, the cursor comes out as a small extra stem-shaped lump,
and everything else stays flat. None of these encode colour;
nothing in the output ever uses a non-fabric tone.

---

## 2. Vertex displacement, with a 9-tap blur

The plane is a `PlaneGeometry(3.2, 3.2, 320, 320)` — ~100k
vertices, generous but not extravagant. Each vertex samples the
atlas through a 9-tap Gaussian:

```glsl
float sampleH(vec2 uv) {
  const float e = 0.006;
  float h = 0.0;
  h += texture2D(uTex, uv + vec2(-e, -e)).r * 0.0625;
  h += texture2D(uTex, uv + vec2(0,   -e)).r * 0.125;
  h += texture2D(uTex, uv + vec2( e,  -e)).r * 0.0625;
  h += texture2D(uTex, uv + vec2(-e,  0 )).r * 0.125;
  h += texture2D(uTex, uv                ).r * 0.25;
  h += texture2D(uTex, uv + vec2( e,  0 )).r * 0.125;
  h += texture2D(uTex, uv + vec2(-e,   e)).r * 0.0625;
  h += texture2D(uTex, uv + vec2(0,    e)).r * 0.125;
  h += texture2D(uTex, uv + vec2( e,   e)).r * 0.0625;
  return h;
}
```

`e = 0.006` is about a fifth of a glyph stem width at the chosen
font size — small enough that the letterform stays recognisable,
large enough that sharp corners on the atlas become rounded slopes
in the surface. That blur *is* the "thin fabric" feel: real
tablecloth doesn't follow object outlines pixel-for-pixel either,
it stretches between high points.

After sampling, a `smoothstep(0.04, 0.92, h)` flattens near-zero
noise so the fabric is genuinely flat away from the letters, and
peaks roll off into rounded tops rather than holding the
canvas-side anti-aliased fringe.

---

## 3. Free normals from `dFdx`/`dFdy`

Computing the surface normal at each fragment is normally a chore:
sample neighbouring heights, finite-difference, transform into
world space, pass through interpolators. None of that is needed
here. We just pass the displaced **world position** as a varying
and let the fragment shader take its screen-space derivative:

```glsl
vec3 dPdx = dFdx(vWorldPos);
vec3 dPdy = dFdy(vWorldPos);
vec3 normal = normalize(cross(dPdx, dPdy));
```

This is the same normal the rasterised triangle would have if you
took a finite-difference at the screen pixel scale. At 320×320
subdivisions the result reads smoothly as fabric, not faceted.
Free in vertex-shader work, no extra texture samples.

WebGL 2 has derivatives in core; we enable
`OES_standard_derivatives` for WebGL 1 via the material's
`extensions: { derivatives: true }` flag.

---

## 4. Shading the fabric

The lighting is a three-tone wrap-shaded fabric:

```glsl
float ndl = dot(normal, L);
float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);
vec3 col = mix(uFabricShade, uFabric, smoothstep(0.0, 0.55, wrap));
col = mix(col, uFabricLit, smoothstep(0.55, 1.0, wrap));
```

- **Wrap shading** (the `+0.45` bias) softens the terminator so the
  back side of a bump still receives some light, matching real
  fabric which has subsurface diffusion. A pure Lambert
  `max(0, N·L)` would put a hard line right where the bump goes
  over the top.
- **Three tones** are mixed at two breakpoints: a warm shade in the
  shadow troughs, the flat fabric colour for the page itself, a
  near-white highlight at the very front of bumps. The bulk of the
  page stays at the flat tone; only the bump faces tip into the
  highlight or shadow. That's where "white on off-white" comes
  from — it isn't tinted text, it's the lit side of a ridge.
- A faint **weave** from a single value-noise tap on
  `gl_FragCoord` adds ±1.5% local variation, so flat fabric off
  the letters has texture instead of being dead plastic.
- A wide **vignette** falls the page edges into shadow so the
  rendered plane melts into the body background (which is
  `FABRIC_HEX` — identical to `uFabric`).

The `uLightDir` is set to `(0.7, 0.65, 0.7)` — coming from the
upper-right, raking across the surface. That's the angle that
sells the ridges. A light from directly in front would flatten
them out entirely.

---

## 5. Camera-follow

Same pattern as cloud-text. The vertex shader maps the plane's
UV to a sub-window of the atlas via `uOrigin + (uv - 0.5) *
uViewSize`; the JS lerps `uOrigin` toward the caret's atlas UV
each frame. Hit testing inverts the same transform.

`uViewSize` defaults to a generous `0.78` of the atlas height —
the page mostly fits, the camera just pans a little when the
caret wanders near an edge.

---

## 6. Knobs

| What | Where | Effect |
| ---- | ----- | ------ |
| `uHeight` | uniform | World-space displacement amount. 0.075 is "thin fabric"; raise toward 0.15 for "billowy"; drop toward 0.03 for "ironed". |
| `smoothstep(0.04, 0.92, h)` | vertex shader | First arg = how aggressively flat areas stay flat. Lower = some fabric ripple. Higher = pure flat away from text. |
| `e = 0.006` | vertex shader | Blur radius. Bigger = softer, more draped letters. Smaller = crisper letterforms with more fabric tension. |
| `uLightDir` | uniform | Where the rake comes from. Try `(0, 1, 0.3)` for top-down lighting that emphasises serif details. |
| `PlaneGeometry(..., 320, 320)` | scene setup | Subdivisions. Drop to 192 if your GPU complains. 96 will start showing facets. |
| `wrap = (ndl + 0.45) / 1.45` | fragment shader | The `+0.45` is how forgiving the back-of-bump shading is. Higher = more uniformly lit. Lower toward 0 = a sharper terminator. |

---

## Files

- `index.html` — mounts the WebGL canvas and the hidden editor host.
- `styles.css` — body background matched to the fabric tone so the
  plane edges blend in.
- `script.js` — CodeMirror setup, the height-atlas painter, the
  three.js scene with the displacement / derivative-normal shader,
  the camera-follow loop, and the pointer hit testing.
- `README.md` — this file.

## Running

Open `index.html` directly, or serve the repo root with
`python3 -m http.server`. No build step; `three`, CodeMirror and
Inter load at runtime.

## Controls

- **Click** to place the caret.
- **Drag** to select — selected lines rise as a soft plateau.
- **Type** — new bumps appear in the fabric.
