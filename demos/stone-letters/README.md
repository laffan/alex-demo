# Letters from stones

The same live editor as the other demos, but each visible glyph is
reassembled out of a few hundred small 3D pebbles. Type a letter,
and a pile of stones materialises in its shape; delete it, and they
vanish. Selection paints them ochre; the caret is a small heap of
amber stones that blinks.

This is demo #03 in the series. It shares the hidden-CodeMirror /
2D-canvas / WebGL-overlay pattern with demos #01 and #02 — see the
[undulating-surface README](../undulating-surface/) for the bones of
that architecture. The only piece that changes is, again, the last
step: how the 2D canvas becomes pixels on the screen.

---

## The picture in one sentence

> A `THREE.InstancedMesh` of low-poly icosahedra, with one instance
> placed at every Nth lit pixel of the editor's rasterised text
> canvas, tinted by the colour-coded category (text / selection /
> cursor) the canvas painted at that pixel.

That's it. No raymarching, no shaders, no custom geometry — just
instancing driven by a CPU-side bitmap walk.

---

## 1. The sampling canvas as a tri-state mask

The texture canvas is rasterised at 1024² (smaller than the previous
demos — we're not minifying GPU samples here, we're doing per-frame
`getImageData` from JS, and 1 MP fits in a few ms of memory copy).
On it we paint three distinct flat colours:

- **Near-black `#101010`** for unselected glyphs and the blockquote
  bar.
- **Red `#c8341d`** for glyphs that fall inside the active selection.
- **Yellow `#f4c020`** for the cursor block.

Everything else is white. The walk that decides selection colour is
character-by-character: as we render each row we check whether each
character's document position is inside `[selFrom, selTo)` and pick
the paint accordingly. This is more work per row than demo #01's
"draw a translucent rectangle behind a black glyph" approach, but it
buys us a single-channel mask where selection survives the
rasterisation cleanly — the instancer needs to classify each lit
pixel from RGB alone, and translucent overlays would make that
ambiguous.

Bowlby One was picked specifically because its strokes are fat
enough that even at FONT_SIZE=78 each stem is ~10 pixels across — at
STRIDE=7 that's room for a stone or two per stem, with enough
thickness that the letterforms don't dissolve into Morse code.

---

## 2. Bitmap → instances

Every frame (gated by a dirty flag — see §4), `rebuildStones()` does
a single `ctx.getImageData(0, 0, TEX, TEX)` and walks the buffer at
a fixed `STRIDE`. For each candidate pixel:

1. **Classify** by RGB: dark → text, red-dominant → selection,
   yellow-ish → cursor, otherwise background (skip).
2. **Compute world position** from the canvas coordinate. The page
   group is a horizontal-ish plane tilted ~30° from flat (a music
   stand, not a floor); a canvas pixel maps to a point on its
   surface via a straightforward UV ↔ XY transform.
3. **Stable jitter** keyed on the integer pixel coords — see §3 —
   produces a per-stone scale, rotation, XY jitter, and lift height.
4. **Tint** by lerping between a base colour and a brighter "hilite"
   per category, using the same hash for the lerp factor so the same
   pixel always paints the same tone.

The matrix and colour get written into the `InstancedMesh` and we
bump the live count. Whatever's beyond the live count keeps whatever
matrices it held last time, but isn't drawn (`stones.count` controls
the draw range).

Cap is `MAX_STONES = 9000`. In practice a typical screenful of body
text uses 1500–3500 instances; the cap is there so a wall of
headings can't blow past it.

---

## 3. Why the per-pixel hash matters

If every frame produced fresh random offsets, the stones would
crawl. The fix is to derive their offsets deterministically from
their grid coordinate:

```js
function pixelSeed(gx, gy) {
  return (gx * 374761393) ^ (gy * 668265263);
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
```

Same pixel → same seed → same scale, rotation, jitter, lift, tint.
The result is that as you type, the new glyph's stones appear in
place and the old ones stay frozen; as you select a range, the
existing stones change colour but don't move. It's the difference
between an effect and a special effect.

The `pixelSeed` here is a cheap Cantor-pair-ish XOR — collision
probability is fine for our 128×128 candidate grid.

---

## 4. Don't rebuild unless the picture changed

`getImageData` is the most expensive thing on this page. A 1024²
read is ~4 MB and shows up clearly in a profile if you do it 60
times a second.

We don't have to. The picture only changes when:

- the document changes (typing, paste, undo),
- the selection moves (anchor or head),
- the cursor blink toggles,
- the visible scroll window shifts (which happens *because* of one
  of the above — never on its own).

So we add a CodeMirror update listener that flips a `dirty` flag on
any doc or selection change, the cursor-blink interval flips it too,
and the per-frame `tick()` only re-rasterises and re-instances when
`dirty` is set:

```js
const dirtyExt = EditorView.updateListener.of((u) => {
  if (u.docChanged || u.selectionSet) dirty = true;
});
setInterval(() => { cursorBlink = !cursorBlink; dirty = true; }, 530);

function tick() {
  if (dirty) {
    renderTexture();
    rebuildStones();
    dirty = false;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
```

`renderer.render` still happens every frame so the camera could be
animated later if we wanted; the heavy work happens only on actual
change. Idle, the page is essentially free.

---

## 5. The scene

Nothing exotic on the rendering side — that's the point. A
`MeshStandardMaterial` on icosahedral stones, lit by:

- a **HemisphereLight** (warm sky on top, sandy ground from below)
  for the wraparound base term,
- a **DirectionalLight** keyed warm and high, and
- a faint cool **rim DirectionalLight** from behind.

The "sky" is a single back-faced sphere with a two-colour gradient
shader — flat, no normal shading, just a vertical lerp. A
`THREE.Fog` matches the lower sky colour so the page edges and the
far stones blend out cleanly without a hard horizon.

The page itself is a single `PlaneGeometry` parented to a tilted
group. That group's transform is the only piece of orientation
maths in the file — every stone lives in the group's local space,
so all the canvas-to-world bookkeeping stays 2D.

---

## 6. Hit testing

The page plane is a real mesh in the scene, so the raycaster
intersects it directly. Once we have a UV we convert to canvas
pixels and then walk `visualRows` — exactly the same routine as
demo #01. The stones themselves are never hit-tested; they aren't
geometrically present where the user clicks (they sit *above* the
plane), and trying to raycast 3000 small instances per click would
be both expensive and pointless.

This is one of the reasons the page plane is kept in the scene as a
visible-but-flat ground rather than thrown away after instancing:
it doubles as the click target.

---

## 7. Knobs

| What | Where | Effect |
| ---- | ----- | ------ |
| `STRIDE` | top of file | Stone density. Lower = more, denser glyphs, slower. 7 is the default. |
| `FONT_SIZE`, `LINE_HEIGHT`, `PADDING` | top of file | How big the glyphs are on the canvas relative to the page. |
| `MAX_STONES` | InstancedMesh setup | Hard cap before the rebuild stops. Raise it if you fill the screen with bold text. |
| `pageGroup.rotation.x` | scene setup | How much the page tips from vertical. -π/2 is fully flat; 0 is a billboard. |
| `STONE_RADIUS` and the scale lerp `0.55 + s * 0.6` | inside `rebuildStones` | Stone size and variance. |
| `lift = scale * (0.4 + s * 1.1)` | inside `rebuildStones` | How much stones lift off the page. Higher = piles, lower = tiles. |
| `STONE_*_BASE` / `_HILITE` colours | top of file | The two-tone palette per category. |

---

## Files

- `index.html` — mounts the WebGL canvas and the hidden editor host.
- `styles.css` — full-screen sand; parks the editor behind the
  canvas via the same z-index trick.
- `script.js` — CodeMirror setup, the tri-state sampling-canvas
  painter, the instanced-mesh stone rebuilder, the scene + lights,
  and the pointer hit testing.
- `README.md` — this file.

## Running

Open `index.html` directly, or serve the repo root with
`python3 -m http.server`. No build step; `three` and CodeMirror load
at runtime from `esm.sh`.

## Controls

- **Click** to place the caret.
- **Drag** to select.
- **Type** — markdown headings and blockquotes still pick up styling.
