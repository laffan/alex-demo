# Letters from stones

The same live editor as the other demos, but each visible glyph is
reassembled out of small stones whose layout actually traces the
shape of the letter. Type a character and a fresh pile of stones
drops onto the page in roughly that shape; delete one and its
stones tumble off the edge under gravity. Selection turns them
ochre; the caret is a small heap of amber stones that pulses.

This is demo #03 in the series. It shares the hidden-CodeMirror
pattern with demos #01 and #02 — see the
[undulating-surface README](../undulating-surface/) for the bones
of that architecture.

---

## The picture in one sentence

> Each unique character is rasterised once into a per-glyph stone
> cluster (jittered-grid sampling of its bitmap); the document is
> a list of `(docPos, glyphStoneIdx)` keys; each key owns one
> stone whose `pos` springs toward a `home` derived from where its
> character currently sits in the layout, with new stones
> spawning above and orphaned stones dropping under gravity.

The first version of this demo placed stones on a fixed grid
walking the *whole* document atlas with `getImageData` every
frame. It was readable as "letters in stones" only loosely — the
grid quantised everything onto the same lattice and mid-edits
re-shuffled the grid identities. The current version fixes both
problems at once: per-character glyph caching gives each letter a
distinctive stone cluster, and a docPos-based identity (remapped
through CodeMirror's change set) keeps stones glued to the
character they belong to.

---

## 1. Per-character glyph cache

For each unique character we touch (Bowlby One at one fixed size),
we render it once into a 256² scratch canvas, walk that canvas in
a jittered-grid pattern, and store one stone offset per opaque
cell:

```
for each grid cell (gx, gy) at stride 5px:
  jitter (jx, jy) inside the cell using a per-cell hash
  if pixel at (gx + jx, gy + jy) is dark:
    record { x, y, scale, rotX, rotY, rotZ, colorT } seeded by the cell
```

The result is cached keyed by character. Every "a" in the document
shares the same cluster of offsets, so it's recognisably an "a";
every "B" shares its own cluster; the variation across the page
comes from where the characters *sit*, not from per-instance
randomness inside each glyph.

The jitter is what saves it from looking like a halftone screen —
the per-cell hash gives each stone a visibly different position,
scale, and rotation, so a stroke reads as a few-stones-wide pile
rather than a column of identical lozenges.

A nice side effect: glyph rasterisation is paid once per unique
character, never per frame. Only the first occurrence of each
letter has any per-glyph cost; the rest are pure cache hits.

---

## 2. Stone identity, and remapping it through edits

Each stone is keyed by `${docPos}:${glyphStoneIdx}`. So the third
stone of the character at document position 17 is `"17:3"`, and
that's stable as long as that character stays at position 17.

What about when you insert a character at position 5? Without
intervention, every character after position 5 has a new docPos —
which would orphan every existing stone after position 5 and spawn
new ones, producing a cascading wave of stones every keystroke in
the middle of a paragraph.

The fix is a CodeMirror update listener that walks every existing
stone's key through the transaction's `ChangeSet`:

```js
EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    const next = new Map();
    for (const [key, stone] of stoneState) {
      const oldPos = parseInt(key.slice(0, key.indexOf(":")), 10);
      const newPos = u.changes.mapPos(oldPos, 1);
      const newKey = `${newPos}:${key.slice(key.indexOf(":") + 1)}`;
      if (next.has(newKey)) {
        // Collision: oldPos was deleted; this stone is now an orphan.
        stone.dying = true;
        next.set("orphan:" + Math.random().toString(36).slice(2), stone);
      } else {
        next.set(newKey, stone);
      }
    }
    stoneState = next;
  }
});
```

`changes.mapPos(oldPos, 1)` is the standard "associate to right"
position remap. Most edits leave most positions intact; the few
positions that *were* deleted collide on remap, and we route the
displaced stones into a uniquely-keyed orphan pool where they get
flagged `dying` and the integrator takes them away under gravity.

---

## 3. Spring physics with drop-in and drop-out

Every stone holds:

```
{ pos, vel, home, rotX, rotY, rotZ, scale, colorBase, colorHi, colorT, dying }
```

Each frame:

1. Build the **target list** — what stones *should* exist right
   now, with their target homes/colours/scales.
2. **Match** targets against `stoneState` by key:
   - Existing stone whose key is still wanted: update its `home`
     and colour, leave `pos`/`vel` alone — the spring will glide
     it.
   - Existing stone whose key is gone: flag `dying`, give it a
     small outward kick (so it tumbles, not just plummets).
   - Wanted target with no existing stone: spawn one at
     `home + (0, SPAWN_LIFT, 0)` with zero velocity.
3. **Integrate** with semi-implicit Euler:
   - Live stones: `vel += (k · (home − pos) − damp · vel) · dt`,
     `pos += vel · dt`.
   - Dying stones: `vel.y += GRAVITY · dt`, no spring; rotate
     around their motion direction so they tumble; remove when they
     fall below `y = -2.5`.
4. **Write** every stone's matrix and colour into the
   `InstancedMesh`.

The default tuning (`SPRING_K = 36`, `DAMP = 7.5`) gives a snappy-
but-not-bouncy settle: a fresh stone hits home in ~0.4s with
maybe one tiny bob. The cursor stones get a per-frame
`scale *= 1 + 0.18·sin(t·4.5)` pulse instead of a blink — a
blinking pile of stones would be a strobe.

The whole stone simulation is a flat O(N) integration — no
neighbour collisions. With ~3000 stones on a typical screen
that's ~12k vector multiplies per frame, well under a millisecond.

---

## 4. World-space stones, page-space layout

Stones live in **world space** (parented to the scene root, not to
the page group). This matters for the dying state: a dying stone
needs to detach from the page, fall straight down in *world* y
under gravity, and disappear past the bottom of the visible scene
— if it were parented to the tilted page group, "down" would mean
"off the back of the page" and stones would bury themselves into
the ground texture.

Their **homes** are computed in page space and then transformed
once into world space:

```js
function pageToWorld(canvasX, canvasY, lift, out) {
  const u = canvasX / TEX, v = canvasY / TEX;
  scratch.set((u - 0.5) * PAGE_WIDTH, -(v - 0.5) * PAGE_DEPTH, lift);
  scratch.applyMatrix4(pageGroup.matrixWorld);
  out.copy(scratch);
}
```

The page group's matrix is static (just the initial tilt), so we
sample its world matrix once at startup and reuse it.

---

## 5. Hit testing

Identical to the previous version: raycast the page plane, recover
its UV, walk `visualRows` + `measureText` to get a doc position.
The stones aren't hit-tested — they sit *above* the page, not on
it, and trying to raycast 3000+ small instances per click would be
both expensive and semantically wrong (you're clicking *on a
character*, not *on a stone*).

---

## 6. Knobs

| What | Where | Effect |
| ---- | ----- | ------ |
| `STRIDE` | top of file | Stones per glyph. Lower = denser glyphs, higher = sparser. 5 is the default. |
| `FONT_SIZE` | top of file | Size of the cached glyph; sets stone density indirectly. |
| `SPRING_K`, `DAMP` | physics constants | How snappy the settle is. Higher k = stiffer; higher damp = no overshoot. |
| `SPAWN_LIFT` | physics constants | How high above its home a new stone spawns. Bigger = more dramatic drop. |
| `GRAVITY` | physics constants | Self-explanatory. Raise to make removed stones fall faster. |
| `MAX_STONES` | InstancedMesh setup | Hard cap. Generous (12000) — typical screens use ~3000. |
| Stone palettes | top of file | Two tones per category (text / selection / cursor). |

---

## Files

- `index.html` — mounts the WebGL canvas and the hidden editor host.
- `styles.css` — full-screen sand; parks the editor behind the
  canvas via the same z-index trick.
- `script.js` — CodeMirror setup with the docPos remap listener,
  the per-character glyph cache, the stone state map + spring
  integrator, the scene + lights, and the pointer hit testing.
- `README.md` — this file.

## Running

Open `index.html` directly, or serve the repo root with
`python3 -m http.server`. No build step; `three` and CodeMirror
load at runtime from `esm.sh`.

## Controls

- **Click** to place the caret.
- **Drag** to select.
- **Type** — new stones drop in. Delete — old ones tumble off.
