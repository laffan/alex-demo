# Letters from stones

The same live editor as the other demos, but each visible glyph is
reconstituted out of small stones whose layout traces the shape of
the letter. Looking straight down at a horizontal page; each stone
has its own physics — falls from a shallow height onto the page,
bounces once or twice on a hard surface, settles. Type a character
and a fresh cluster of stones rains down in its shape; delete one
and its stones get kicked outward and tumble off the page.

This is demo #03 in the series. Same hidden-CodeMirror /
2D-canvas / WebGL-overlay pattern as the rest — see the
[undulating-surface README](../undulating-surface/) for the bones
of that architecture.

---

## The picture in one sentence

> Each unique character is rasterised once into a per-glyph stone
> cluster (jittered-grid sampling of its bitmap); the document is
> a list of `(docPos, glyphStoneIdx)` keys; each stone integrates
> its own gravity + hard-surface-bounce + lateral-spring physics
> over a stable home position derived from where its character
> sits in the layout.

The first version of this demo placed stones on a fixed grid and
moved them as a unit toward each letter's target. They looked
correct but bounced in lockstep — the whole letter pulsing as a
single spring system. The current version replaces the springs
with real per-stone gravity on a hard horizontal surface and adds
a staggered spawn delay so the cluster *rains* into place rather
than dropping as a single body.

---

## 1. Per-character glyph cache

For each unique character we touch we render it once into a 384²
scratch canvas, walk that canvas on a jittered grid (`STRIDE = 14`,
~60–90 cells lit per Bowlby-One letter), and store a list of stone
offsets along with per-stone randomness drawn from the same hash:
scale, rotation, base colour mix, spawn delay, drop-extra,
restitution, and an XZ "kick" direction.

```js
stones.push({
  x: px - 1,
  y: py - 1 - ascent,
  scale: 0.55 + r() * 0.6,
  rotX: (r() - 0.5) * 0.7,
  rotY: (r() - 0.5) * 0.7,
  rotZ: r() * Math.PI * 2,
  colorT: r(),
  delay: r() * 0.35,
  dropExtra: r() * 0.25,
  kickX: r() - 0.5,
  kickZ: r() - 0.5,
  restitution: 0.28 + r() * 0.12,
});
```

The randomness is keyed on `(charCode, cellIndex)` so every "a" in
the document is the same shape — recognisable as an a — but every
stone within an a has its own physical parameters. That's the
distinction: glyph *shape* is shared across instances, glyph
*behaviour* is per-stone.

The cache is paid once per unique character; the rest of the
document is pure cache hits.

---

## 2. Drop physics on a hard surface

Each stone holds `{ pos, vel, homeX, homeZ, restitution, delay,
age, dying }`. The page is the XZ plane at `y = 0`; a stone at rest
has its centre at `y = STONE_RADIUS`.

Per frame, after `dt = min(getDelta(), 1/30)`:

```js
s.age += dt;
if (!s.dying && s.age < s.delay) continue;   // pending — still on its spawn timer

if (s.dying) {
  s.vel.y += GRAVITY * dt;
  s.pos.addScaledVector(s.vel, dt);
  // tumble while falling
  if (s.pos.y < -3) stoneState.delete(k);
  continue;
}

// Live stone — vertical: gravity + hard surface at STONE_RADIUS.
s.vel.y += GRAVITY * dt;
s.pos.y += s.vel.y * dt;
if (s.pos.y < STONE_RADIUS) {
  s.pos.y = STONE_RADIUS;
  if (s.vel.y < -SETTLE_VEL) {
    s.vel.y = -s.vel.y * s.restitution;  // bounce
    s.vel.x *= 0.55;                     // friction kills lateral skid
    s.vel.z *= 0.55;
  } else {
    s.vel.y = 0;                         // settled
  }
}

// Live stone — horizontal: a soft spring to (homeX, homeZ), so
// layout shifts (text reflow, scroll) make stones SLIDE rather
// than teleport.
const dxh = s.homeX - s.pos.x;
const dzh = s.homeZ - s.pos.z;
s.vel.x += (LATERAL_K * dxh - LATERAL_DAMP * s.vel.x) * dt;
s.vel.z += (LATERAL_K * dzh - LATERAL_DAMP * s.vel.z) * dt;
s.pos.x += s.vel.x * dt;
s.pos.z += s.vel.z * dt;
```

Three things make the result feel like individual stones rather
than a single bouncing letter:

1. **Per-stone spawn delay.** Each stone of a newly-typed letter
   gets a random `delay` of 0–0.35 s; until its `age` exceeds
   that, the stone is held off-stage at zero scale and not
   integrated. The letter spawns over the course of a third of a
   second, not all at one instant.
2. **Per-stone restitution.** Each stone bounces a slightly
   different amount, so the bounces don't synchronise.
3. **Separated axes.** Y is hard-surface bounce; X and Z are soft
   spring. A letter that gets layout-shifted by an edit makes the
   stones *slide* across the page rather than teleporting or
   resetting, but the bounce dynamics are completely physical.

Dying stones get a strong outward kick (random horizontal
direction, 1.6 m/s upward) and lose surface collision so they fall
through and below the page. Looks like they fly off.

---

## 3. Stone identity remapped through edits

Same as the previous version: each stone is keyed by
`${docPos}:${glyphStoneIdx}` and a CodeMirror `updateListener`
remaps every existing stone's docPos through the transaction's
`changes.mapPos(oldPos, 1)`. Without this, every keystroke in the
middle of a paragraph would cascade-respawn everything after it.
With it, stones for the same character slide to the new layout
position and existing physics state survives.

When a remap collides — meaning the character at `oldPos` was
deleted and is colliding with a survivor — the displaced stone
gets a unique `"orphan:..."` key in the dying pool, where the
gravity-only path takes it off the page.

---

## 4. Straight-down camera with tracking

The page is horizontal (`PlaneGeometry` rotated `-π/2` around X)
and the camera is parked directly above it:

```js
camera.up.set(0, 0, -1);
camera.position.set(0, CAMERA_HEIGHT, 0);
camera.lookAt(0, 0, 0);
```

`camera.up.set(0, 0, -1)` is the only fiddly bit. With a default
camera looking straight down (forward `(0, -1, 0)`), the up
direction is otherwise undefined; pinning it to world `-Z` puts
the top of the canvas (which maps to world `-Z` through the
page's rotation) at the top of the screen.

Tracking: `cursorWorldX/Z` are computed in `buildTargets()` from
the caret's atlas position; each frame `camTargetX/Z` lerps toward
them and the camera's position is set to `(camTargetX, H,
camTargetZ)`. A pre-frame **clamp** keeps the visible window
inside the page bounds — at the camera's height we know exactly
how much of the world is on screen, so we clamp the target so
`PAGE_WIDTH × PAGE_DEPTH` always covers the viewport on every
edge.

The lerp factor `0.10` is the only sticky parameter: high enough
to keep up with sustained typing, low enough that arrow-key
sweeps glide rather than jump.

---

## 5. Hit testing

Identical to the previous version: raycast the page plane, recover
its UV, walk `visualRows` + `measureText` to get a doc position.
The stones aren't hit-tested. The page plane's UV is the
ground-truth coordinate space for both rendering and clicks; the
stones live above it as decoration.

The page is now horizontal in world space, so the UV recovery just
inverts `pageToWorld` — the raycaster does the page-rotation work
for free.

---

## 6. Knobs

| What | Where | Effect |
| ---- | ----- | ------ |
| `STRIDE` | top of file | Stones per glyph. 14 → ~60–90 in Bowlby One. Drop to 11 for denser, raise to 18 for sparser. |
| `STONE_RADIUS` | scene setup | World-space stone size. About half the previous demo's. |
| `FONT_SIZE` | top of file | Canvas-space glyph size. Twice the previous demo's. |
| `DROP_HEIGHT` | physics constants | How far above the page a fresh stone spawns. 0.4 = "shallow drop"; raise toward 1.0 for "rain from a height". |
| `LATERAL_K`, `LATERAL_DAMP` | physics constants | How tightly stones track layout shifts in XZ. Higher K = quicker slide. |
| `SETTLE_VEL` | physics constants | Below this |vel.y| the bounce stops. Lower = more tiny bounces, higher = stones stop sooner. |
| `s.restitution` range (in glyph cache) | per-stone bounce | The `0.28 + r() * 0.12` band — wider = more visible variation between stones. |
| `CAMERA_HEIGHT`, FOV | scene setup | How much of the page is visible. Pull camera up or widen FOV to see more at once. |
| Camera-track lerp `0.10` | `updateCamera()` | How sticky the camera is to the caret. |

---

## Files

- `index.html` — mounts the WebGL canvas and the hidden editor host.
- `styles.css` — body background matched to the sky tone so the page
  edges fall away cleanly.
- `script.js` — CodeMirror with the docPos remap listener, the
  per-character glyph cache, the per-stone physics integrator, the
  scene with straight-down tracking camera, and pointer hit testing.
- `README.md` — this file.

## Running

Open `index.html` directly, or serve the repo root with
`python3 -m http.server`.

## Controls

- **Click** to place the caret.
- **Drag** to select.
- **Type** — new stones rain in. Delete — old ones get kicked out
  and fall.
