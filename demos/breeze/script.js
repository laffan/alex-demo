import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette. A dark slate ground; letter-shaped cloths are textured
//    with the shared linen pattern so they read as actual scraps of
//    fabric falling onto the page.
// ------------------------------------------------------------------
const GROUND_HEX = "#1a1c22";
const FILL_LIGHT_HEX = "#a4b3c6";
const SELECT_HEX = "#4a90e2";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor. Each insertion at the end of the doc
//    spawns a fresh cloth letter at the next layout slot; each
//    deletion at the end removes the last cloth. Mid-doc edits
//    rebuild from scratch since the layout shifts.
// ------------------------------------------------------------------
const initialDoc = ``;

const view = new EditorView({
  doc: initialDoc,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) syncDoc();
      if (u.docChanged || u.selectionSet) syncSelection();
    }),
  ],
  parent: document.getElementById("editor-host"),
});
view.focus();

// ------------------------------------------------------------------
// 2. Letter mask generator. Each unique character gets rasterised
//    once at high resolution into a binary mask: the cloth particles
//    live only at "on" mask cells. Blocky sans-serif (Bowlby One)
//    so the letterforms have chunky strokes that read clearly even
//    when the cloth folds.
// ------------------------------------------------------------------
// Mask resolution is what the letterforms get rasterised into; it
// doubles as the cloth's particle grid. 22 was just coarse enough
// that strokes looked roughly chopped out of a stencil — 40 gives
// the curves of Bowlby One a recognizable shape (~2.7× the
// particle/spring count, still cheap at this scale).
const MASK_RES = 40;
// Font size must fit inside MASK_RES with margin for ascenders + descenders.
// Bowlby One paints close to its full em-box; ~32px keeps an 'h' or 'g'
// fully inside the 40px canvas instead of getting clipped to a square.
const MASK_FONT = '900 32px "Bowlby One", "Inter", sans-serif';

const maskCanvas = document.createElement("canvas");
maskCanvas.width = MASK_RES;
maskCanvas.height = MASK_RES;
const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });

const maskCache = new Map();
function maskFor(ch) {
  if (maskCache.has(ch)) return maskCache.get(ch);
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, MASK_RES, MASK_RES);
  mctx.fillStyle = "#fff";
  mctx.font = MASK_FONT;
  mctx.textBaseline = "middle";
  mctx.textAlign = "center";
  // Nudge baseline down a touch — most caps + descenders read better
  // when the glyph sits slightly above the cell centre.
  mctx.fillText(ch, MASK_RES / 2, MASK_RES / 2 + 1);
  const img = mctx.getImageData(0, 0, MASK_RES, MASK_RES).data;
  const mask = new Uint8Array(MASK_RES * MASK_RES);
  for (let i = 0; i < MASK_RES * MASK_RES; i++) {
    mask[i] = img[i * 4] > 96 ? 1 : 0;
  }
  maskCache.set(ch, mask);
  return mask;
}

// ------------------------------------------------------------------
// 3. three.js setup. Top-down perspective camera so cloths drop
//    *toward* the viewer (close at the moment of typing, smaller
//    once they've settled flat against the ground).
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(GROUND_HEX);
scene.fog = new THREE.Fog(GROUND_HEX, 14, 32);

const camera = new THREE.PerspectiveCamera(
  44,
  window.innerWidth / window.innerHeight,
  0.1,
  60,
);
// Pulled back so the first row of typed letters (which spawn near
// X = -((COLS_PER_LINE-1) * CHAR_ADV) / 2) is comfortably inside the
// visible frustum on standard window aspects.
camera.position.set(0, 12.0, 0.001);
camera.lookAt(0, 0, 0);

// Lights. A keylight from the side gives the falling letters
// visible shadows on the ground; an under-fill keeps the cloth from
// going pitch-black where it has folded back on itself.
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(4, 6, 3);
key.castShadow = true;
key.shadow.camera.left = -5;
key.shadow.camera.right = 5;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -5;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 16;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0005;
scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, FILL_LIGHT_HEX, 0.45));

// Linen texture used by every cloth letter.
const linenTex = new THREE.TextureLoader().load("./pattern.jpg", (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
});
linenTex.wrapS = linenTex.wrapT = THREE.RepeatWrapping;
linenTex.colorSpace = THREE.SRGBColorSpace;

// Ground plane. Lit by the shadow-casting key light so each cloth
// drops a clearly readable shadow as it falls. Slightly darker than
// the scene background so the page visually frames itself.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(GROUND_HEX),
    roughness: 0.95,
    metalness: 0.0,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

// ------------------------------------------------------------------
// 4. Cloth simulation. Verlet integration with constraint
//    relaxation, run on the CPU. The three.js WebGPU example we're
//    modelling after uses compute shaders, but the algorithm is the
//    same: integrate, then iteratively pull each pair of connected
//    particles back to its rest length. A few passes per frame is
//    enough to keep the cloth stable as it drapes.
//
//    Each Cloth instance owns:
//      • particles[]   — current and previous positions, pinned flag
//      • springs[]     — index pairs + rest lengths
//      • mesh / geom   — three.js handle for rendering
//      • settled       — once average motion stays tiny for a while
//                        we stop simulating this cloth (huge win for
//                        long docs).
// ------------------------------------------------------------------
// CELL scales inversely with MASK_RES so each letter's world size
// stays roughly the same as before the resolution bump
// (MASK_RES * CELL ≈ 0.99 world units across).
const CELL = 0.025;
const CLOTH_THICKNESS = 0.005;
const GRAVITY = -7.0;
const SUBSTEPS = 3;
const CONSTRAINT_ITERS = 5;
// Wind direction & magnitude: a gentle, time-varying breeze from
// the top of the screen (the -Z direction in world space because
// the camera looks straight down). Kept low enough that a grounded
// cloth's residual jitter drops under SETTLE_VEL_THRESHOLD and the
// settle latch can fire; the old values (1.8 / 1.0) kept landed
// cloths in perpetual wobble, which read as them re-falling whenever
// a fresh letter dropped nearby.
const WIND_BASE = new THREE.Vector3(0.0, 0.0, 0.55);
const WIND_VARY_AMP = 0.25;
// Above this height, a particle is treated as airborne and receives
// wind; below it, it's "lying on the page" and wind is suppressed so
// settled cloths stop drifting.
const WIND_GROUND_CUTOFF = CLOTH_THICKNESS * 4;
const SETTLE_VEL_THRESHOLD = 0.0008;
const SETTLE_FRAMES = 60;

class Cloth {
  constructor(char, spawnX, spawnZ, dropDelay) {
    this.char = char;
    this.spawnX = spawnX;
    this.spawnZ = spawnZ;
    this.dropDelay = dropDelay; // seconds before gravity kicks in
    this.age = 0;
    this.settledCount = 0;
    this.settled = false;

    const mask = maskFor(char);
    const M = MASK_RES;
    // Build particle array and an (x,y) -> particle-index map.
    this.idxMap = new Int32Array(M * M).fill(-1);
    const positions = [];
    const uvs = [];
    for (let y = 0; y < M; y++) {
      for (let x = 0; x < M; x++) {
        if (mask[y * M + x] === 0) continue;
        // Centre the letter on the spawn point in X/Z; spawn high
        // above the ground in Y.
        const wx = spawnX + (x - M / 2) * CELL;
        const wz = spawnZ + (y - M / 2) * CELL;
        const wy = 1.5 + Math.random() * 0.1;
        this.idxMap[y * M + x] = positions.length / 3;
        positions.push(wx, wy, wz);
        uvs.push(x / (M - 1), 1 - y / (M - 1));
      }
    }
    const n = positions.length / 3;
    this.pos = new Float32Array(positions);
    this.prev = new Float32Array(positions); // start at rest
    this.pinned = new Uint8Array(n); // all loose

    // Springs: 4-neighbour structural + 4-neighbour diagonal + 2-step
    // bending. Bending springs are what stop a fallen cloth from
    // crumpling into a hairball — they preserve a rough flatness
    // over short distances without making the cloth feel rigid.
    const springs = [];
    const addSpring = (ax, ay, bx, by) => {
      if (bx < 0 || bx >= M || by < 0 || by >= M) return;
      const a = this.idxMap[ay * M + ax];
      const b = this.idxMap[by * M + bx];
      if (a < 0 || b < 0) return;
      const dx = (bx - ax) * CELL;
      const dz = (by - ay) * CELL;
      springs.push(a, b, Math.hypot(dx, dz));
    };
    for (let y = 0; y < M; y++) {
      for (let x = 0; x < M; x++) {
        if (this.idxMap[y * M + x] < 0) continue;
        addSpring(x, y, x + 1, y);
        addSpring(x, y, x, y + 1);
        addSpring(x, y, x + 1, y + 1);
        addSpring(x, y, x + 1, y - 1);
        // Bending springs at distance 2.
        addSpring(x, y, x + 2, y);
        addSpring(x, y, x, y + 2);
      }
    }
    // Pack springs as parallel typed arrays so the inner relaxation
    // loop stays in the JIT-friendly integer index path.
    const ns = springs.length / 3;
    this.springA = new Uint32Array(ns);
    this.springB = new Uint32Array(ns);
    this.springLen = new Float32Array(ns);
    for (let i = 0; i < ns; i++) {
      this.springA[i] = springs[i * 3];
      this.springB[i] = springs[i * 3 + 1];
      this.springLen[i] = springs[i * 3 + 2];
    }

    // Triangulate every 2×2 cell of the mask whose four corners are
    // all present. Some cells have only 3 or 2 corners (the edge of
    // a glyph stroke) — those get a single triangle if we can find
    // 3 of the 4 corners. Without that fallback the strokes have
    // visible holes along their boundaries.
    const indices = [];
    for (let y = 0; y < M - 1; y++) {
      for (let x = 0; x < M - 1; x++) {
        const a = this.idxMap[y * M + x];
        const b = this.idxMap[y * M + (x + 1)];
        const c = this.idxMap[(y + 1) * M + x];
        const d = this.idxMap[(y + 1) * M + (x + 1)];
        if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
          indices.push(a, c, b, b, c, d);
        } else if (a >= 0 && b >= 0 && c >= 0) {
          indices.push(a, c, b);
        } else if (a >= 0 && b >= 0 && d >= 0) {
          indices.push(a, d, b);
        } else if (a >= 0 && c >= 0 && d >= 0) {
          indices.push(a, c, d);
        } else if (b >= 0 && c >= 0 && d >= 0) {
          indices.push(b, c, d);
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: linenTex,
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    this.mat = mat;
    this.selected = false;
    this.geom = geom;
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // The bounding sphere is computed once from initial spawn-height
    // positions; once the cloth falls, that sphere is stale and will
    // frustum-cull the mesh on near-camera framings. Cheap to just
    // always draw the cloth.
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  step(dt, t) {
    if (this.settled) return;
    this.age += dt;
    const dropping = this.age >= this.dropDelay;
    const damp = 0.985;
    // Wind drifts on uTime so neighbouring cloths receive slightly
    // different gusts.
    const windZ = WIND_BASE.z + Math.sin(t * 0.6 + this.spawnX * 0.4) * WIND_VARY_AMP;
    const windX = Math.sin(t * 0.8 + this.spawnZ * 0.3) * 0.45;
    const ax = windX * dt * dt;
    const az = windZ * dt * dt;
    // While the cloth is still "hanging" at its spawn height (drop
    // delay hasn't elapsed) we apply only a tiny micro-gust so the
    // letter visibly wobbles in place before falling.
    const gravStep = dropping ? GRAVITY * dt * dt : -0.15 * dt * dt;

    const pos = this.pos;
    const prev = this.prev;
    let maxMove = 0;
    for (let i = 0; i < pos.length; i += 3) {
      // Verlet integrate
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const dx = x - prev[i];
      const dy = y - prev[i + 1];
      const dz = z - prev[i + 2];
      prev[i] = x;
      prev[i + 1] = y;
      prev[i + 2] = z;
      // Wind only acts on airborne particles. Once a particle is
      // resting on the page, suppressing wind lets the residual
      // velocity bleed off via the ground-damp step and the cloth
      // can actually reach the settle threshold.
      const airborne = y > WIND_GROUND_CUTOFF;
      const wx_ = airborne ? ax : 0;
      const wz_ = airborne ? az : 0;
      const nx = x + dx * damp + wx_;
      const ny = y + dy * damp + gravStep;
      const nz = z + dz * damp + wz_;
      pos[i] = nx;
      pos[i + 1] = ny;
      pos[i + 2] = nz;
      const move = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (move > maxMove) maxMove = move;
    }

    // Constraint relaxation. Each pass nudges every spring back
    // toward its rest length; a handful of passes is enough to
    // settle the cloth on the ground without it stretching.
    const springA = this.springA;
    const springB = this.springB;
    const springLen = this.springLen;
    const ns = springA.length;
    for (let iter = 0; iter < CONSTRAINT_ITERS; iter++) {
      for (let i = 0; i < ns; i++) {
        const a = springA[i] * 3;
        const b = springB[i] * 3;
        const rest = springLen[i];
        const ddx = pos[b] - pos[a];
        const ddy = pos[b + 1] - pos[a + 1];
        const ddz = pos[b + 2] - pos[a + 2];
        const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (dist2 < 1e-12) continue;
        const dist = Math.sqrt(dist2);
        const diff = (dist - rest) / dist * 0.5;
        const ox = ddx * diff;
        const oy = ddy * diff;
        const oz = ddz * diff;
        pos[a]     += ox;
        pos[a + 1] += oy;
        pos[a + 2] += oz;
        pos[b]     -= ox;
        pos[b + 1] -= oy;
        pos[b + 2] -= oz;
      }
    }

    // Ground collision. Floor at y = CLOTH_THICKNESS so cloth lays
    // *on top* of the ground rather than co-planar with the shadow
    // catcher. When a particle hits the floor, we also damp its
    // horizontal Verlet velocity so the cloth grips rather than
    // sliding indefinitely on the floor.
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] < CLOTH_THICKNESS) {
        pos[i + 1] = CLOTH_THICKNESS;
        prev[i]     += (pos[i]     - prev[i])     * 0.4;
        prev[i + 2] += (pos[i + 2] - prev[i + 2]) * 0.4;
      }
    }

    this.geom.attributes.position.needsUpdate = true;
    // Recompute normals only every few frames — it's relatively
    // expensive and the eye can't tell the difference at 60Hz.
    if (((this.age * 30) | 0) % 2 === 0) {
      this.geom.computeVertexNormals();
    }

    // Settle detection. Once movement has been below the threshold
    // for SETTLE_FRAMES consecutive frames we lock the cloth.
    if (dropping && maxMove < SETTLE_VEL_THRESHOLD) {
      this.settledCount++;
      if (this.settledCount > SETTLE_FRAMES) {
        this.settled = true;
        this.geom.computeVertexNormals();
      }
    } else {
      this.settledCount = 0;
    }
  }

  setSelected(on) {
    if (on === this.selected) return;
    this.selected = on;
    // Tint the linen texture by multiplying it with a blue when the
    // char falls inside the editor's selection range. The texture
    // remains visible — the cloth just reads as dyed fabric.
    this.mat.color.set(on ? SELECT_HEX : 0xffffff);
  }

  dispose() {
    scene.remove(this.mesh);
    this.geom.dispose();
    this.mesh.material.dispose();
  }
}

// ------------------------------------------------------------------
// 5. Layout. Each typed character gets a (col, row) slot; columns
//    advance by CHAR_ADV in world X, rows by LINE_PITCH in world Z.
//    The layout wraps when it reaches the right edge of the visible
//    page so long docs cascade down the screen.
// ------------------------------------------------------------------
const CHAR_ADV = MASK_RES * CELL * 0.85;
const LINE_PITCH = MASK_RES * CELL * 1.15;
// Narrowed from 14 so the leftmost cloth (at -((COLS-1)*CHAR_ADV)/2)
// sits comfortably inside the camera frustum on near-square windows;
// wider screens still get the rest of the page through the horizontal
// FOV widening with aspect.
const COLS_PER_LINE = 12;
const START_X = -((COLS_PER_LINE - 1) * CHAR_ADV) / 2;
const START_Z = -((4 - 1) * LINE_PITCH) / 2;

let activeCloths = []; // parallel to currently-displayed printable chars
let lastSyncedText = "";

// Caret marker. A small blue sphere floating just above the page at
// the slot where the next typed character would land. We render it
// with a touch of emissive so it stays readable against the dark
// ground even when the key light is grazing.
const cursorMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 20, 16),
  new THREE.MeshStandardMaterial({
    color: SELECT_HEX,
    emissive: SELECT_HEX,
    emissiveIntensity: 0.55,
    roughness: 0.35,
    metalness: 0.1,
  }),
);
cursorMesh.castShadow = true;
// Rest on the page: sphere centre = its radius above y=0.
cursorMesh.position.set(0, 0.07, 0);
scene.add(cursorMesh);

// Point light parented to the cursor so its glow spills onto nearby
// cloths — gives the sphere the impression of being a real source of
// light rather than just a tinted material.
const cursorLight = new THREE.PointLight(SELECT_HEX, 2.4, 3.5, 1.8);
cursorLight.position.set(0, 0.35, 0);
scene.add(cursorLight);

function caretSlot() {
  // Walk the doc up to the caret position and return the (col, row)
  // of the slot the next-typed char would occupy. Mirrors the wrap
  // logic in layoutFor so the sphere lines up with where a new cloth
  // would actually spawn.
  const pos = view.state.selection.main.head;
  const text = view.state.doc.toString();
  let col = 0;
  let row = 0;
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      col = 0;
      row++;
      continue;
    }
    if (col >= COLS_PER_LINE) {
      col = 0;
      row++;
    }
    col++;
  }
  if (col >= COLS_PER_LINE) {
    col = 0;
    row++;
  }
  return { col, row };
}

function syncSelection() {
  const sel = view.state.selection.main;
  const from = Math.min(sel.anchor, sel.head);
  const to = Math.max(sel.anchor, sel.head);
  const text = view.state.doc.toString();

  // Map [from, to) in doc-space onto cloth indices (skipping the
  // non-printable chars that don't get a cloth).
  let clothIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === " ") continue;
    if (clothIdx < activeCloths.length) {
      activeCloths[clothIdx].setSelected(i >= from && i < to);
    }
    clothIdx++;
  }

  const { col, row } = caretSlot();
  cursorMesh.position.x = START_X + col * CHAR_ADV;
  cursorMesh.position.z = START_Z + row * LINE_PITCH;
  cursorLight.position.x = cursorMesh.position.x;
  cursorLight.position.z = cursorMesh.position.z;
}

function layoutFor(text) {
  // Returns an array of {char, col, row} for every printable char in
  // text, doing the same wrap logic so spawnCloth's geometry lines
  // up.
  const slots = [];
  let col = 0;
  let row = 0;
  for (const ch of text) {
    if (ch === "\n") {
      col = 0;
      row++;
      continue;
    }
    if (col >= COLS_PER_LINE) {
      col = 0;
      row++;
    }
    if (ch === " ") {
      col++;
      continue;
    }
    slots.push({ char: ch, col, row });
    col++;
  }
  return slots;
}

function syncDoc() {
  const text = view.state.doc.toString();
  const slots = layoutFor(text);

  // Find the longest common prefix between the previously-synced
  // text and the new text. Everything before the divergence point is
  // unchanged — those cloths stay settled in place. Everything from
  // the divergence point onward is disposed and respawned.
  //
  // Earlier the function only had startsWith fast paths for
  // append/backspace-at-end; any other edit (mid-doc insertion, a
  // selection-then-replace, a click-and-type that put the caret away
  // from the end) fell through to a full rebuild, which made every
  // already-settled letter drop again. The prefix-based approach
  // handles all of those cases correctly *and* keeps only the
  // genuinely-changed characters in motion.
  let prefixLen = 0;
  const limit = Math.min(text.length, lastSyncedText.length);
  while (
    prefixLen < limit &&
    text.charCodeAt(prefixLen) === lastSyncedText.charCodeAt(prefixLen)
  ) {
    prefixLen++;
  }
  // Convert the doc-character prefix length to a cloth-index
  // survivor count (spaces / newlines are not represented as cloths).
  const survivors = layoutFor(text.slice(0, prefixLen)).length;

  while (activeCloths.length > survivors) {
    activeCloths.pop().dispose();
  }

  for (let i = activeCloths.length; i < slots.length; i++) {
    const s = slots[i];
    const x = START_X + s.col * CHAR_ADV;
    const z = START_Z + s.row * LINE_PITCH;
    // Stagger drops by ~80 ms so very fast typing still reads as
    // a sequence rather than a single cloud falling at once.
    const dropDelay = 0.08 * (i - activeCloths.length);
    activeCloths.push(new Cloth(s.char, x, z, dropDelay));
  }

  lastSyncedText = text;
}

// ------------------------------------------------------------------
// 6. Click / drag → caret. Hit the ground plane, convert (x, z) to
//    a layout cell, walk the doc to find the matching doc position.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(ground);
  if (!hits.length) return view.state.doc.length;
  const p = hits[0].point;
  const tCol = Math.round((p.x - START_X) / CHAR_ADV);
  const tRow = Math.round((p.z - START_Z) / LINE_PITCH);

  const text = view.state.doc.toString();
  let col = 0;
  let row = 0;
  let best = text.length;
  let bestDist = Infinity;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      col = 0;
      row++;
      continue;
    }
    if (col >= COLS_PER_LINE) {
      col = 0;
      row++;
    }
    const dx = col - tCol;
    const dy = row - tRow;
    const d = dx * dx + dy * dy * 1.8;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
    col++;
  }
  return best;
}

let dragging = false;
let dragAnchor = 0;
const stageEl = document.getElementById("stage");

stageEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  view.focus();
  const pos = docPosFromPointer(e);
  if (pos === null) return;
  dragAnchor = pos;
  dragging = true;
  stageEl.setPointerCapture(e.pointerId);
  view.dispatch({
    selection: { anchor: pos, head: pos },
    userEvent: "select.pointer",
  });
});
stageEl.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const pos = docPosFromPointer(e);
  if (pos === null) return;
  view.dispatch({
    selection: { anchor: dragAnchor, head: pos },
    userEvent: "select.pointer",
  });
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try {
    stageEl.releasePointerCapture(e.pointerId);
  } catch {}
  view.focus();
}
stageEl.addEventListener("pointerup", endDrag);
stageEl.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------------
// 7. Resize + animation loop. The CPU sim runs at a fixed substep
//    rate so the cloth's stability doesn't depend on the browser's
//    frame rate.
// ------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", resize);
resize();

const FIXED_DT = 1 / 60;
const clock = new THREE.Clock();
let accumulator = 0;
function tick() {
  const frameDt = Math.min(clock.getDelta(), 0.05);
  accumulator += frameDt;
  const t = clock.elapsedTime;
  while (accumulator >= FIXED_DT) {
    const sub = FIXED_DT / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const c of activeCloths) c.step(sub, t);
    }
    accumulator -= FIXED_DT;
  }
  // Cursor pulse. Scale stays at 1 so the sphere remains seated on
  // the page; instead we breathe the emissive and the point-light
  // intensity together so the glow visibly throbs across the cloth.
  const pulse = 0.85 + 0.25 * Math.sin(t * 3.0);
  cursorMesh.material.emissiveIntensity = 0.6 * pulse + 0.35;
  cursorLight.intensity = 2.0 * pulse + 1.1;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`900 30px "Bowlby One"`).then(() => {
  // Invalidate any masks we generated with the fallback font.
  maskCache.clear();
  syncDoc();
  syncSelection();
  tick();
});
