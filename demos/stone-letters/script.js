import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette.
// ------------------------------------------------------------------
const SKY_TOP_HEX = "#c9b58a";
const SKY_BOTTOM_HEX = "#8d7848";
const GROUND_HEX = "#b9a376";

const STONE_TEXT_BASE = new THREE.Color("#3a2f24");
const STONE_TEXT_HI = new THREE.Color("#7a6249");
const STONE_SELECT_BASE = new THREE.Color("#a23a17");
const STONE_SELECT_HI = new THREE.Color("#dd6a2c");
const STONE_CURSOR_BASE = new THREE.Color("#f5b630");
const STONE_CURSOR_HI = new THREE.Color("#fff0a8");

// ------------------------------------------------------------------
// 1. Hidden CodeMirror 6 editor. Stones live in world space and are
//    keyed by `${docPos}:${glyphStoneIdx}`; when the doc changes we
//    remap docPos through the change set so existing stones glide to
//    their new homes instead of cascading.
// ------------------------------------------------------------------
let stoneState = new Map();
let dirty = true;

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
      if (u.docChanged) {
        // Walk the change set so each stone's char identity follows
        // its character through inserts/deletes. Without this, any
        // mid-document edit would re-key every following stone and
        // the whole tail of the document would respawn.
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
            // Collision: the character at oldPos was deleted and is
            // colliding with a survivor. Push this stone into the
            // dying pool with a unique key so it falls cleanly.
            stone.dying = true;
            next.set("orphan:" + Math.random().toString(36).slice(2), stone);
          } else {
            next.set(newKey, stone);
          }
        }
        stoneState = next;
        dirty = true;
      }
      if (u.selectionSet) dirty = true;
    }),
  ],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Layout-measurement canvas. We never actually rasterise the doc
//    here — we only need measureText for word wrap and per-character
//    advance. Glyph *pixels* come from the per-character cache below.
// ------------------------------------------------------------------
const TEX = 1024;
const FONT_SIZE = 100;
const LINE_HEIGHT = 134;
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
// 3. Per-character glyph cache.
//
//    For each unique character we render the glyph once into a small
//    canvas, then walk it on a jittered grid: each grid cell that
//    contains an opaque pixel becomes one stone offset (with stable
//    randomised scale, rotation, and tone). The stone cluster is
//    keyed by the glyph's pixel shape, which is what makes a "B"
//    look like a B and an "O" like an O.
//
//    The cache is keyed by character only — a Bowlby-One "a" is
//    always the same shape, so the same offsets work everywhere it
//    appears in the document. Per-instance variation comes from the
//    docPos prefix on the stone key, not from the glyph cache.
// ------------------------------------------------------------------
const CACHE = 256;
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
const STRIDE = 5; // pixels between candidate stones in the cache canvas

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
          x: px - 1, // canvas-pixel offset from glyph left
          y: py - 1 - ascent, // canvas-pixel offset from baseline
          scale: 0.55 + r() * 0.6,
          rotX: (r() - 0.5) * 0.7,
          rotY: (r() - 0.5) * 0.7,
          rotZ: r() * Math.PI * 2,
          colorT: r(),
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
// 4. three.js scene.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_BOTTOM_HEX);
scene.fog = new THREE.Fog(SKY_BOTTOM_HEX, 6, 14);

// Sky dome.
{
  const skyGeo = new THREE.SphereGeometry(40, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uTop: { value: new THREE.Color(SKY_TOP_HEX) },
      uBot: { value: new THREE.Color(SKY_BOTTOM_HEX) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uBot;
      varying vec3 vPos;
      void main() {
        float h = clamp((vPos.y / 40.0) * 0.5 + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(mix(uBot, uTop, smoothstep(0.2, 0.95, h)), 1.0);
      }
    `,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
}

// Tilted page. Stones sit on (and above) this plane.
const PAGE_WIDTH = 5.4;
const PAGE_DEPTH = 5.4;
const pageGroup = new THREE.Group();
pageGroup.rotation.x = -1.05;
pageGroup.position.set(0, 0.05, -0.4);
scene.add(pageGroup);

const groundGeo = new THREE.PlaneGeometry(PAGE_WIDTH, PAGE_DEPTH, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(GROUND_HEX),
  roughness: 0.95,
  metalness: 0.0,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
pageGroup.add(ground);

// Lights.
scene.add(new THREE.HemisphereLight(SKY_TOP_HEX, GROUND_HEX, 0.55));
{
  const key = new THREE.DirectionalLight(0xfff1c4, 1.25);
  key.position.set(2.2, 4.0, 2.5);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x9fb8d0, 0.35);
  rim.position.set(-3.0, 2.5, -2.0);
  scene.add(rim);
}

const camera = new THREE.PerspectiveCamera(
  38,
  window.innerWidth / window.innerHeight,
  0.05,
  50,
);
camera.position.set(0, 1.55, 3.05);
camera.lookAt(0, 0, -0.5);

// Force pageGroup's matrixWorld to be current — we sample it below
// when computing world-space stone homes from page-local positions.
scene.updateMatrixWorld(true);

// ------------------------------------------------------------------
// 5. InstancedMesh of stones — one slot per live stone, regardless
//    of which character they belong to.
// ------------------------------------------------------------------
const MAX_STONES = 12000;
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
scene.add(stones); // lives in world space, NOT under pageGroup
{
  const colors = new Float32Array(MAX_STONES * 3);
  stones.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  stones.instanceColor.setUsage(THREE.DynamicDrawUsage);
}

const dummy = new THREE.Object3D();
const dummyColor = new THREE.Color();

const STONE_RADIUS = (PAGE_WIDTH / TEX) * STRIDE * 0.78;
const SPAWN_LIFT = 0.9; // world units a new stone falls from

// Convert a (canvas-x, canvas-y, lift) page-local coord to world.
const _scratch = new THREE.Vector3();
function pageToWorld(canvasX, canvasY, lift, out) {
  const u = canvasX / TEX;
  const v = canvasY / TEX;
  _scratch.set((u - 0.5) * PAGE_WIDTH, -(v - 0.5) * PAGE_DEPTH, lift);
  _scratch.applyMatrix4(pageGroup.matrixWorld);
  out.copy(_scratch);
}

// ------------------------------------------------------------------
// 6. Compute the per-frame target list — one entry per stone that
//    should currently exist. The stoneState map then matches these
//    targets against existing stones (re-using identity), spawns new
//    ones, and marks dropped ones as dying.
// ------------------------------------------------------------------
const targetHome = new THREE.Vector3();

function buildTargets(out) {
  out.length = 0;

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

  let cursorCanvasX = PADDING;
  let cursorCanvasY = PADDING;

  let y = PADDING;
  for (let r = scrollTopRow; r < visualRows.length; r++) {
    const row = visualRows[r];
    let x = PADDING;

    for (let i = 0; i < row.text.length; i++) {
      const ch = row.text[i];
      const docPos = row.startDocPos + i;

      if (ch === " " || ch === "\t") {
        x += lctx.measureText(ch).width;
        if (r === cursorRowIdx && docPos === head) {
          cursorCanvasX = x;
          cursorCanvasY = y + FONT_SIZE * 0.5;
        }
        continue;
      }

      const entry = getGlyph(ch);
      const baseline = y + FONT_SIZE * 0.85;
      const inSel = hasRange && docPos >= selFrom && docPos < selTo;

      if (r === cursorRowIdx && docPos === head) {
        cursorCanvasX = x;
        cursorCanvasY = y + FONT_SIZE * 0.5;
      }

      for (let j = 0; j < entry.stones.length; j++) {
        const st = entry.stones[j];
        const cx = x + st.x;
        const cy = baseline + st.y;
        const lift = STONE_RADIUS * (0.4 + st.colorT * 1.0);
        pageToWorld(cx, cy, lift, targetHome);

        out.push({
          key: `${docPos}:${j}`,
          home: targetHome.clone(),
          colorBase: inSel ? STONE_SELECT_BASE : STONE_TEXT_BASE,
          colorHi: inSel ? STONE_SELECT_HI : STONE_TEXT_HI,
          colorT: st.colorT,
          scale: STONE_RADIUS * st.scale,
          rotX: st.rotX,
          rotY: st.rotY,
          rotZ: st.rotZ,
        });
      }
      x += entry.advance;
    }

    if (r === cursorRowIdx && head >= row.endDocPos) {
      cursorCanvasX = x;
      cursorCanvasY = y + FONT_SIZE * 0.5;
    }
    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }

  // Cursor: a small heap of bright stones at the caret position.
  // Always present — no blink — because a blinking pile would be a
  // distracting strobe. Pulse via a per-frame scale instead.
  const CURSOR_STONE_COUNT = 9;
  for (let i = 0; i < CURSOR_STONE_COUNT; i++) {
    const r = rng(pixelSeed(2718281, i));
    const jx = (r() - 0.5) * STONE_RADIUS * 1.6;
    const jy = (r() - 0.5) * FONT_SIZE * 0.45;
    const lift = STONE_RADIUS * (0.5 + r() * 1.2);
    pageToWorld(cursorCanvasX + jx, cursorCanvasY + jy, lift, targetHome);
    out.push({
      key: `cursor:${i}`,
      home: targetHome.clone(),
      colorBase: STONE_CURSOR_BASE,
      colorHi: STONE_CURSOR_HI,
      colorT: r(),
      scale: STONE_RADIUS * (0.7 + r() * 0.5),
      rotX: (r() - 0.5) * 0.6,
      rotY: (r() - 0.5) * 0.6,
      rotZ: r() * Math.PI * 2,
    });
  }
}

// ------------------------------------------------------------------
// 7. Match targets → existing stones; spawn / mark-dying as needed;
//    integrate physics; write to InstancedMesh.
// ------------------------------------------------------------------
const SPRING_K = 36;
const DAMP = 7.5;
const GRAVITY = -9.8;
const targets = [];
const seenKeys = new Set();
const _tmpVec = new THREE.Vector3();

function step(dt) {
  buildTargets(targets);

  seenKeys.clear();
  for (const t of targets) {
    let s = stoneState.get(t.key);
    if (!s) {
      // New stone — spawn above its home with zero velocity. The
      // spring will pull it down; damping will catch it.
      s = {
        pos: t.home.clone().add(_tmpVec.set(0, SPAWN_LIFT, 0)),
        vel: new THREE.Vector3(),
        home: t.home.clone(),
        rotX: t.rotX,
        rotY: t.rotY,
        rotZ: t.rotZ,
        scale: t.scale,
        colorBase: t.colorBase,
        colorHi: t.colorHi,
        colorT: t.colorT,
        dying: false,
      };
      stoneState.set(t.key, s);
    } else {
      s.home.copy(t.home);
      s.colorBase = t.colorBase;
      s.colorHi = t.colorHi;
      s.scale = t.scale;
      s.dying = false;
    }
    seenKeys.add(t.key);
  }

  // Anything not seen this frame is being deleted. Cut it loose from
  // its spring; gravity will take it from there.
  for (const [k, s] of stoneState) {
    if (!seenKeys.has(k) && !s.dying) {
      s.dying = true;
      // a tiny outward kick so they tumble rather than just plummet
      s.vel.x += (Math.random() - 0.5) * 0.6;
      s.vel.z += (Math.random() - 0.5) * 0.6;
      s.vel.y += 0.4 + Math.random() * 0.4;
    }
  }

  // Integrate.
  for (const [k, s] of stoneState) {
    if (s.dying) {
      s.vel.y += GRAVITY * dt;
      s.pos.addScaledVector(s.vel, dt);
      // tumble
      s.rotX += s.vel.z * dt * 0.8;
      s.rotZ += s.vel.x * dt * 0.8;
      if (s.pos.y < -2.5) stoneState.delete(k);
    } else {
      const dx = s.home.x - s.pos.x;
      const dy = s.home.y - s.pos.y;
      const dz = s.home.z - s.pos.z;
      s.vel.x += (SPRING_K * dx - DAMP * s.vel.x) * dt;
      s.vel.y += (SPRING_K * dy - DAMP * s.vel.y) * dt;
      s.vel.z += (SPRING_K * dz - DAMP * s.vel.z) * dt;
      s.pos.addScaledVector(s.vel, dt);
    }
  }

  // Write to InstancedMesh.
  let i = 0;
  const t = clock.getElapsedTime();
  const cursorPulse = 1.0 + 0.18 * Math.sin(t * 4.5);
  for (const [k, s] of stoneState) {
    if (i >= MAX_STONES) break;
    const isCursor = k.startsWith("cursor:");
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
// 8. Pointer hit testing — same routine as demo #01: raycast the
//    page plane, get the UV, walk visualRows + measureText to recover
//    a doc position. The stones themselves aren't hit-tested.
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
// 9. Resize + animation loop. Physics + InstancedMesh writes happen
//    every frame — they're cheap (no canvas readback now that the
//    glyph cache pays the rasterisation cost once per character).
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
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Bowlby One"`).then(() => {
  // Pre-warm the cache for the initial doc so the first frame
  // already has stones (and the spring snaps them in nicely).
  for (const ch of initialDoc) {
    if (ch !== " " && ch !== "\n" && ch !== "\t") getGlyph(ch);
  }
  tick();
});
