import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette.
// ------------------------------------------------------------------
const SKY_HEX = "#cdb98a";
const GROUND_HEX = "#b9a376";

const STONE_TEXT_BASE = new THREE.Color("#3a2f24");
const STONE_TEXT_HI = new THREE.Color("#7a6249");
const STONE_SELECT_BASE = new THREE.Color("#a23a17");
const STONE_SELECT_HI = new THREE.Color("#dd6a2c");
const STONE_CURSOR_BASE = new THREE.Color("#f5b630");
const STONE_CURSOR_HI = new THREE.Color("#fff0a8");

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor. Stones live in world space, keyed by
//    `${docPos}:${glyphStoneIdx}`. An updateListener remaps docPos
//    through the change set so mid-document edits don't cascade.
// ------------------------------------------------------------------
let stoneState = new Map();

const initialDoc = `STONES

each letter you type is built
out of small stones, sampled
from the rasterised shape of
the glyph itself.

type — they fall in.
delete — they tumble off.`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const next = new Map();
      for (const [key, stone] of stoneState) {
        const colon = key.indexOf(":");
        const head = key.slice(0, colon);
        if (head === "cursor" || head === "orphan") {
          next.set(key, stone);
          continue;
        }
        const oldPos = parseInt(head, 10);
        const newPos = u.changes.mapPos(oldPos, 1);
        const newKey = `${newPos}:${key.slice(colon + 1)}`;
        if (next.has(newKey)) {
          stone.dying = true;
          next.set("orphan:" + Math.random().toString(36).slice(2), stone);
        } else {
          next.set(newKey, stone);
        }
      }
      stoneState = next;
    }),
  ],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Layout-measurement canvas. We only use it for measureText; the
//    actual glyph pixels come from the per-character cache below.
// ------------------------------------------------------------------
const TEX = 1536;
const FONT_SIZE = 200;
const LINE_HEIGHT = 260;
const PADDING = 80;
const FONT_FAMILY = '"Bowlby One", sans-serif';

const layoutCanvas = document.createElement("canvas");
layoutCanvas.width = TEX;
layoutCanvas.height = TEX;
const lctx = layoutCanvas.getContext("2d");
lctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
lctx.textBaseline = "alphabetic";

let visualRows = [];
let scrollTopRow = 0;

function wrapText(text, maxWidth) {
  if (text.length === 0) return [{ text: "", startCol: 0 }];
  const tokens = text.match(/\s+|\S+/g) || [];
  const segs = [];
  let segStart = 0;
  let segText = "";
  let pos = 0;
  for (const tok of tokens) {
    const test = segText + tok;
    if (lctx.measureText(test).width > maxWidth && segText.length > 0) {
      segs.push({ text: segText, startCol: segStart });
      segStart = pos;
      segText = tok;
    } else {
      segText = test;
    }
    pos += tok.length;
  }
  if (segText.length > 0 || segs.length === 0) {
    segs.push({ text: segText, startCol: segStart });
  }
  return segs;
}

function computeLayout() {
  const doc = view.state.doc;
  const rows = [];
  const maxWidth = TEX - 2 * PADDING;
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum);
    const segs = wrapText(line.text, maxWidth);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const startDocPos = line.from + seg.startCol;
      rows.push({
        text: seg.text,
        startDocPos,
        endDocPos: startDocPos + seg.text.length,
        isFirstInLine: i === 0,
        isLastInLine: i === segs.length - 1,
      });
    }
  }
  return rows;
}

function findCursorRow(rows, head) {
  let best = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.startDocPos <= head && head <= r.endDocPos) best = i;
    else if (r.startDocPos > head) break;
  }
  return best;
}

// ------------------------------------------------------------------
// 3. Per-character glyph cache. Rasterise once, walk on a jittered
//    grid, store one stone offset per opaque cell. Cached forever.
// ------------------------------------------------------------------
const CACHE = 384;
const cacheCanvas = document.createElement("canvas");
cacheCanvas.width = CACHE;
cacheCanvas.height = CACHE;
const cctx = cacheCanvas.getContext("2d", { willReadFrequently: true });

function pixelSeed(a, b) {
  return ((a | 0) * 374761393) ^ ((b | 0) * 668265263);
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const glyphCache = new Map();
const STRIDE = 14; // ~60–90 stones per character in Bowlby One

function getGlyph(ch) {
  const cached = glyphCache.get(ch);
  if (cached) return cached;

  cctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  cctx.textBaseline = "alphabetic";
  const m = cctx.measureText(ch);
  const advance = m.width;
  const ascent = (m.actualBoundingBoxAscent || FONT_SIZE * 0.85) | 0;
  const descent = (m.actualBoundingBoxDescent || FONT_SIZE * 0.25) | 0;
  const w = Math.max(1, Math.ceil(m.actualBoundingBoxRight ?? advance) + 2);
  const h = Math.max(1, ascent + descent + 2);

  cctx.clearRect(0, 0, CACHE, CACHE);
  cctx.fillStyle = "#000";
  cctx.fillText(ch, 1, ascent + 1);

  const img = cctx.getImageData(0, 0, w, h).data;
  const stones = [];
  let idx = 0;
  for (let gy = 0; gy < h - 1; gy += STRIDE) {
    for (let gx = 0; gx < w - 1; gx += STRIDE) {
      const r = rng(pixelSeed(ch.charCodeAt(0) || 0, idx));
      const jx = r();
      const jy = r();
      const px = Math.min(w - 1, (gx + jx * STRIDE) | 0);
      const py = Math.min(h - 1, (gy + jy * STRIDE) | 0);
      const i = (py * w + px) * 4;
      const lit = img[i + 3] > 80 && img[i] + img[i + 1] + img[i + 2] < 250;
      if (lit) {
        stones.push({
          x: px - 1,
          y: py - 1 - ascent,
          scale: 0.55 + r() * 0.6,
          rotX: (r() - 0.5) * 0.7,
          rotY: (r() - 0.5) * 0.7,
          rotZ: r() * Math.PI * 2,
          colorT: r(),
          // Cached pseudo-randomness consumed when the live stone
          // spawns. r() must be called a stable number of times per
          // cell so the per-pixel seed stays deterministic across
          // calls.
          delay: r() * 0.35,
          dropExtra: r() * 0.25,
          kickX: r() - 0.5,
          kickZ: r() - 0.5,
          restitution: 0.28 + r() * 0.12,
        });
      }
      idx++;
    }
  }
  const entry = { advance, ascent, descent, stones };
  glyphCache.set(ch, entry);
  return entry;
}

// ------------------------------------------------------------------
// 4. three.js scene. Page is *horizontal* (XZ plane at y=0), camera
//    is *straight down* from above, with horizontal tracking that
//    glides the camera toward the caret each frame.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_HEX);
scene.fog = new THREE.Fog(SKY_HEX, 8, 18);

const PAGE_WIDTH = 8.0;
const PAGE_DEPTH = 8.0;

// Horizontal page in XZ plane.
const groundGeo = new THREE.PlaneGeometry(PAGE_WIDTH, PAGE_DEPTH, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(GROUND_HEX),
  roughness: 0.95,
  metalness: 0.0,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
scene.add(ground);

// Lights. Key light angled off-vertical so the stones have visible
// shading from straight overhead. Hemisphere gives a soft fill so
// the undersides of pebbles aren't pitch-black.
scene.add(new THREE.HemisphereLight(0xfff4d4, GROUND_HEX, 0.55));
{
  const key = new THREE.DirectionalLight(0xfff3c8, 1.2);
  key.position.set(2.6, 5.0, 2.0);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb8d0, 0.32);
  rim.position.set(-3.0, 4.0, -2.5);
  scene.add(rim);
}

const CAMERA_HEIGHT = 9.0;
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  60,
);
// World "up" on screen = -Z, so canvas-top (which maps to world
// -Z after our pageToWorld) becomes the top of the screen.
camera.up.set(0, 0, -1);
camera.position.set(0, CAMERA_HEIGHT, 0);
camera.lookAt(0, 0, 0);
scene.updateMatrixWorld(true);

// ------------------------------------------------------------------
// 5. Page-canvas → world. Canvas Y runs top→bottom; we map that to
//    world Z so the top of the document is at world -Z.
// ------------------------------------------------------------------
function pageToWorld(canvasX, canvasY, lift, out) {
  const u = canvasX / TEX;
  const v = canvasY / TEX;
  out.set((u - 0.5) * PAGE_WIDTH, lift, (v - 0.5) * PAGE_DEPTH);
}

// ------------------------------------------------------------------
// 6. Stones — InstancedMesh, world space.
// ------------------------------------------------------------------
const MAX_STONES = 16000;
const stoneGeo = new THREE.IcosahedronGeometry(1.0, 0);
stoneGeo.scale(1.0, 0.78, 1.0);
const stoneMat = new THREE.MeshStandardMaterial({
  vertexColors: false,
  roughness: 0.85,
  metalness: 0.05,
});
const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, MAX_STONES);
stones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
stones.count = 0;
scene.add(stones);
{
  const colors = new Float32Array(MAX_STONES * 3);
  stones.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  stones.instanceColor.setUsage(THREE.DynamicDrawUsage);
}

const dummy = new THREE.Object3D();
const dummyColor = new THREE.Color();

// Smaller stones than the previous version — about half the world
// radius. With STRIDE=14 we get plenty of stones per character so
// even at this size the letterforms remain readable.
const STONE_RADIUS = 0.012;

// Physics constants.
const GRAVITY = -9.8;
const DROP_HEIGHT = 0.4; // shallow — stones drop from ~half a glyph height
const LATERAL_K = 6.0; // how strongly horizontal motion is pulled to home
const LATERAL_DAMP = 5.0;
const SETTLE_VEL = 0.08; // |vel.y| below this when on-surface → snap to rest

// ------------------------------------------------------------------
// 7. Build target list — one entry per stone that should exist this
//    frame. Each target carries everything the integrator needs.
// ------------------------------------------------------------------
const targets = [];
const seenKeys = new Set();
const _home = new THREE.Vector3();

let cursorWorldX = 0;
let cursorWorldZ = 0;

function computeCursorAtlasPos() {
  const head = view.state.selection.main.head;
  if (visualRows.length === 0) return { x: PADDING, y: PADDING };
  const cursorRowIdx = findCursorRow(visualRows, head);
  const row = visualRows[cursorRowIdx];
  const yInRows = cursorRowIdx - scrollTopRow;
  const yCanvas = PADDING + yInRows * LINE_HEIGHT + FONT_SIZE * 0.5;
  const localCol = Math.min(
    Math.max(0, head - row.startDocPos),
    row.text.length,
  );
  lctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  const wBefore = lctx.measureText(row.text.slice(0, localCol)).width;
  return { x: PADDING + wBefore, y: yCanvas };
}

function buildTargets() {
  targets.length = 0;
  visualRows = computeLayout();

  const sel = view.state.selection.main;
  const head = sel.head;
  const selFrom = Math.min(sel.from, sel.to);
  const selTo = Math.max(sel.from, sel.to);
  const hasRange = selFrom !== selTo;

  const cursorRowIdx = findCursorRow(visualRows, head);
  const visibleRowCount = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
  if (cursorRowIdx < scrollTopRow) scrollTopRow = cursorRowIdx;
  if (cursorRowIdx >= scrollTopRow + visibleRowCount)
    scrollTopRow = cursorRowIdx - visibleRowCount + 1;
  if (scrollTopRow < 0) scrollTopRow = 0;

  let y = PADDING;
  for (let r = scrollTopRow; r < visualRows.length; r++) {
    const row = visualRows[r];
    let x = PADDING;

    for (let i = 0; i < row.text.length; i++) {
      const ch = row.text[i];
      const docPos = row.startDocPos + i;

      if (ch === " " || ch === "\t") {
        x += lctx.measureText(ch).width;
        continue;
      }

      const entry = getGlyph(ch);
      const baseline = y + FONT_SIZE * 0.85;
      const inSel = hasRange && docPos >= selFrom && docPos < selTo;

      for (let j = 0; j < entry.stones.length; j++) {
        const st = entry.stones[j];
        const cx = x + st.x;
        const cy = baseline + st.y;
        // Home sits on the page surface — its Y is STONE_RADIUS so
        // a resting stone's centre is one radius above the table.
        pageToWorld(cx, cy, STONE_RADIUS, _home);

        targets.push({
          key: `${docPos}:${j}`,
          homeX: _home.x,
          homeZ: _home.z,
          colorBase: inSel ? STONE_SELECT_BASE : STONE_TEXT_BASE,
          colorHi: inSel ? STONE_SELECT_HI : STONE_TEXT_HI,
          colorT: st.colorT,
          scale: STONE_RADIUS * st.scale,
          rotX: st.rotX,
          rotY: st.rotY,
          rotZ: st.rotZ,
          delay: st.delay,
          dropExtra: st.dropExtra,
          kickX: st.kickX,
          kickZ: st.kickZ,
          restitution: st.restitution,
        });
      }
      x += entry.advance;
    }
    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }

  // Cursor — a small column of bright stones at the caret. They get
  // the same drop physics as text stones, so when the cursor moves
  // (or you first open the page) they fall in like everything else.
  const cur = computeCursorAtlasPos();
  pageToWorld(cur.x, cur.y, 0, _home);
  cursorWorldX = _home.x;
  cursorWorldZ = _home.z;

  const CURSOR_STONE_COUNT = 14;
  for (let i = 0; i < CURSOR_STONE_COUNT; i++) {
    const r = rng(pixelSeed(2718281, i));
    const dx = (r() - 0.5) * STONE_RADIUS * 1.8;
    const dz = (r() - 0.5) * FONT_SIZE * 0.5 * (PAGE_DEPTH / TEX);
    pageToWorld(cur.x, cur.y, STONE_RADIUS, _home);
    targets.push({
      key: `cursor:${i}`,
      homeX: _home.x + dx,
      homeZ: _home.z + dz,
      colorBase: STONE_CURSOR_BASE,
      colorHi: STONE_CURSOR_HI,
      colorT: r(),
      scale: STONE_RADIUS * (0.7 + r() * 0.5),
      rotX: (r() - 0.5) * 0.6,
      rotY: (r() - 0.5) * 0.6,
      rotZ: r() * Math.PI * 2,
      delay: r() * 0.2,
      dropExtra: r() * 0.15,
      kickX: r() - 0.5,
      kickZ: r() - 0.5,
      restitution: 0.30 + r() * 0.10,
    });
  }
}

// ------------------------------------------------------------------
// 8. Match targets → existing stones, spawn / mark-dying, integrate
//    physics, write to the InstancedMesh.
// ------------------------------------------------------------------
function step(dt) {
  buildTargets();

  seenKeys.clear();
  for (const t of targets) {
    let s = stoneState.get(t.key);
    if (!s) {
      // New stone — drop in from a small height above its home,
      // with a randomised spawn delay so the whole letter doesn't
      // hit the table at the same instant.
      s = {
        pos: new THREE.Vector3(
          t.homeX + t.kickX * STONE_RADIUS * 0.6,
          STONE_RADIUS + DROP_HEIGHT + t.dropExtra,
          t.homeZ + t.kickZ * STONE_RADIUS * 0.6,
        ),
        vel: new THREE.Vector3(0, 0, 0),
        homeX: t.homeX,
        homeZ: t.homeZ,
        rotX: t.rotX,
        rotY: t.rotY,
        rotZ: t.rotZ,
        scale: t.scale,
        colorBase: t.colorBase,
        colorHi: t.colorHi,
        colorT: t.colorT,
        restitution: t.restitution,
        delay: t.delay,
        age: 0,
        atRest: false,
        dying: false,
      };
      stoneState.set(t.key, s);
    } else {
      s.homeX = t.homeX;
      s.homeZ = t.homeZ;
      s.colorBase = t.colorBase;
      s.colorHi = t.colorHi;
      s.scale = t.scale;
      s.dying = false;
    }
    seenKeys.add(t.key);
  }

  for (const [k, s] of stoneState) {
    if (!seenKeys.has(k) && !s.dying) {
      // Cut from the lateral spring and kick outward + up. They fall
      // through the page (no surface collision while dying) and out
      // of view.
      s.dying = true;
      const ang = Math.random() * Math.PI * 2;
      s.vel.x = Math.cos(ang) * (1.4 + Math.random() * 0.8);
      s.vel.z = Math.sin(ang) * (1.4 + Math.random() * 0.8);
      s.vel.y = 1.6 + Math.random() * 0.8;
    }
  }

  for (const [k, s] of stoneState) {
    s.age += dt;

    // Pending — still in the air on its spawn delay. Hide but don't
    // integrate. (We render with scale 0 below.)
    if (!s.dying && s.age < s.delay) continue;

    if (s.dying) {
      s.vel.y += GRAVITY * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.rotX += s.vel.z * dt * 2.4;
      s.rotZ += s.vel.x * dt * 2.4;
      if (s.pos.y < -3) stoneState.delete(k);
      continue;
    }

    // Live stone physics.
    //  - Vertical: gravity + hard bounce on y = STONE_RADIUS.
    //  - Horizontal: a soft spring to (homeX, homeZ) so layout
    //    shifts produce a slide, not a teleport.
    s.vel.y += GRAVITY * dt;
    s.pos.y += s.vel.y * dt;
    if (s.pos.y < STONE_RADIUS) {
      s.pos.y = STONE_RADIUS;
      if (s.vel.y < -SETTLE_VEL) {
        s.vel.y = -s.vel.y * s.restitution;
        // friction on landing — kills lateral skid
        s.vel.x *= 0.55;
        s.vel.z *= 0.55;
        // tumble a little on impact
        s.rotX += s.vel.z * 0.3;
        s.rotZ -= s.vel.x * 0.3;
      } else {
        s.vel.y = 0;
        s.atRest = true;
      }
    } else {
      s.atRest = false;
    }

    const dxh = s.homeX - s.pos.x;
    const dzh = s.homeZ - s.pos.z;
    s.vel.x += (LATERAL_K * dxh - LATERAL_DAMP * s.vel.x) * dt;
    s.vel.z += (LATERAL_K * dzh - LATERAL_DAMP * s.vel.z) * dt;
    s.pos.x += s.vel.x * dt;
    s.pos.z += s.vel.z * dt;
  }

  // Write to InstancedMesh.
  let i = 0;
  const tNow = clock.getElapsedTime();
  const cursorPulse = 1.0 + 0.16 * Math.sin(tNow * 4.5);

  for (const [k, s] of stoneState) {
    if (i >= MAX_STONES) break;
    const isCursor = k.startsWith("cursor:");
    const pending = !s.dying && s.age < s.delay;

    if (pending) {
      // Render at zero scale (effectively invisible) until the
      // spawn delay elapses; this keeps the slot live in the
      // InstancedMesh but produces no on-screen blip.
      dummy.position.set(0, -100, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(0.0001);
      dummy.updateMatrix();
      stones.setMatrixAt(i, dummy.matrix);
      dummyColor.setRGB(0, 0, 0);
      stones.setColorAt(i, dummyColor);
      i++;
      continue;
    }

    const scaleMul = isCursor ? cursorPulse : 1.0;
    dummy.position.copy(s.pos);
    dummy.rotation.set(s.rotX, s.rotY, s.rotZ);
    dummy.scale.setScalar(s.scale * scaleMul);
    dummy.updateMatrix();
    stones.setMatrixAt(i, dummy.matrix);

    dummyColor.copy(s.colorBase).lerp(s.colorHi, s.colorT * 0.7);
    if (s.dying) dummyColor.multiplyScalar(0.85);
    stones.setColorAt(i, dummyColor);

    i++;
  }
  stones.count = i;
  stones.instanceMatrix.needsUpdate = true;
  if (stones.instanceColor) stones.instanceColor.needsUpdate = true;
}

// ------------------------------------------------------------------
// 9. Camera tracking. The camera glides over the page in XZ,
//    keeping the caret near the centre. Clamped so the visible
//    window stays inside the page bounds.
// ------------------------------------------------------------------
let camTargetX = 0;
let camTargetZ = 0;

function updateCamera() {
  // Half the visible width/depth at the camera's height — used to
  // clamp the tracking target so we never see past a page edge.
  const halfFovV = (camera.fov * 0.5 * Math.PI) / 180;
  const halfH = Math.tan(halfFovV) * CAMERA_HEIGHT;
  const halfW = halfH * camera.aspect;

  const margin = 0.1;
  const maxX = PAGE_WIDTH * 0.5 - halfW + margin;
  const minX = -maxX;
  const maxZ = PAGE_DEPTH * 0.5 - halfH + margin;
  const minZ = -maxZ;

  let tx = Math.min(Math.max(cursorWorldX, minX), maxX);
  let tz = Math.min(Math.max(cursorWorldZ, minZ), maxZ);
  if (maxX < minX) tx = 0; // viewport bigger than page — just centre
  if (maxZ < minZ) tz = 0;

  camTargetX += (tx - camTargetX) * 0.10;
  camTargetZ += (tz - camTargetZ) * 0.10;
  camera.position.set(camTargetX, CAMERA_HEIGHT, camTargetZ);
  camera.lookAt(camTargetX, 0, camTargetZ);
}

// ------------------------------------------------------------------
// 10. Pointer hit testing — raycast the page plane, recover UV,
//     walk visualRows + measureText to get a doc position.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(ground);
  if (!hits.length || !hits[0].uv) return null;

  const uv = hits[0].uv;
  // PlaneGeometry default UVs: u=0 left, v=0 bottom. After we
  // rotated the ground by -π/2 around X, vertex local-Y mapped to
  // world -Z, so a world-space hit at z = -PAGE_DEPTH/2 hits the
  // top of the original geometry → v=1. We invert to get canvas Y.
  const px = uv.x * TEX;
  const py = (1 - uv.y) * TEX;

  if (visualRows.length === 0) return null;

  const rowOffset = Math.floor((py - PADDING) / LINE_HEIGHT);
  let rowIdx = scrollTopRow + rowOffset;
  if (rowIdx < 0) rowIdx = 0;
  if (rowIdx >= visualRows.length) rowIdx = visualRows.length - 1;
  const row = visualRows[rowIdx];

  lctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  const targetX = Math.max(0, px - PADDING);
  let col = row.text.length;
  let prevW = 0;
  for (let i = 1; i <= row.text.length; i++) {
    const w = lctx.measureText(row.text.slice(0, i)).width;
    if (targetX < (prevW + w) / 2) {
      col = i - 1;
      break;
    }
    prevW = w;
  }
  return row.startDocPos + col;
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
// 11. Resize + animation loop.
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

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 1 / 30);
  step(dt);
  updateCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Bowlby One"`).then(() => {
  for (const ch of initialDoc) {
    if (ch !== " " && ch !== "\n" && ch !== "\t") getGlyph(ch);
  }
  // Snap camera to its initial target so we don't pan from (0,0) on
  // the first frame.
  buildTargets();
  camTargetX = cursorWorldX;
  camTargetZ = cursorWorldZ;
  tick();
});
