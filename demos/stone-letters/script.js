import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette — earthen and dry.
// ------------------------------------------------------------------
const SKY_TOP_HEX = "#c9b58a";
const SKY_BOTTOM_HEX = "#8d7848";
const GROUND_HEX = "#b9a376";

// Channel-encoded colours painted into the sampling canvas. The
// instancer reads these back as three category masks: text (dark),
// selection (red), cursor (yellow).
const PAINT_TEXT = "#101010";
const PAINT_SELECT = "#c8341d";
const PAINT_CURSOR = "#f4c020";

// Stone colours per category — tinted toward warm light from above.
const STONE_TEXT_BASE = new THREE.Color("#3a2f24");
const STONE_TEXT_HILITE = new THREE.Color("#766049");
const STONE_SELECT_BASE = new THREE.Color("#a23a17");
const STONE_SELECT_HILITE = new THREE.Color("#dd6a2c");
const STONE_CURSOR_BASE = new THREE.Color("#f6c64a");
const STONE_CURSOR_HILITE = new THREE.Color("#fff3b8");

// ------------------------------------------------------------------
// 1. Hidden CodeMirror 6 editor.
// ------------------------------------------------------------------
const initialDoc = `STONES

Every letter you type is built
out of small pebbles, instanced
from the rasterised shape of the
glyph itself.

# A heading is louder.
> A quote is bracketed.`;

// `dirty` gates the (relatively expensive) ImageData read + stone
// rebuild. Anything that changes the picture — typing, selection
// move, cursor blink, scroll — flips it true.
let dirty = true;

const view = new EditorView({
  doc: initialDoc,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) dirty = true;
    }),
  ],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Sampling canvas — small enough to ImageData every frame, large
//    enough that thick glyph strokes get a few stones across them.
//    We render with three flat colours; the instancer turns each
//    colour into a stone tint.
// ------------------------------------------------------------------
const TEX = 1024;
const STRIDE = 7; // pixels between candidate stone positions
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d", { willReadFrequently: true });

const FONT_SIZE = 78;
const LINE_HEIGHT = 96;
const PADDING = 80;
const FONT_FAMILY = '"Bowlby One", "Inter", sans-serif';

let cursorBlink = true;
setInterval(() => {
  cursorBlink = !cursorBlink;
  dirty = true;
}, 530);

let scrollTopRow = 0;
let visualRows = [];

function lineStyle(text) {
  const h = /^(#{1,6})\s+/.exec(text);
  if (h) {
    const level = h[1].length;
    return {
      size: Math.max(FONT_SIZE - (level - 1) * 8, FONT_SIZE - 24),
      bar: false,
      heading: true,
    };
  }
  if (/^>\s?/.test(text)) {
    return { size: FONT_SIZE, bar: true, heading: false };
  }
  return { size: FONT_SIZE, bar: false, heading: false };
}

function setFont(s) {
  tctx.font = `${s.size}px ${FONT_FAMILY}`;
}

function wrapText(text, maxWidth) {
  if (text.length === 0) return [{ text: "", startCol: 0 }];
  const tokens = text.match(/\s+|\S+/g) || [];
  const segs = [];
  let segStart = 0;
  let segText = "";
  let pos = 0;
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
    const style = lineStyle(line.text);
    setFont(style);
    const segs = wrapText(line.text, maxWidth);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const startDocPos = line.from + seg.startCol;
      rows.push({
        text: seg.text,
        startDocPos,
        endDocPos: startDocPos + seg.text.length,
        style,
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

function renderTexture() {
  tctx.fillStyle = "#ffffff";
  tctx.fillRect(0, 0, TEX, TEX);

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

  tctx.textBaseline = "alphabetic";

  let y = PADDING;
  for (let r = scrollTopRow; r < visualRows.length; r++) {
    const row = visualRows[r];
    const s = row.style;
    setFont(s);
    const baseline = y + s.size * 0.85;

    if (s.bar && row.isFirstInLine) {
      tctx.fillStyle = PAINT_TEXT;
      tctx.fillRect(PADDING - 22, y + 8, 8, s.size - 16);
    }

    // Walk the row character-by-character so each glyph can be
    // painted in either the text or selection colour depending on
    // whether its doc position is inside the active range. The
    // resulting canvas is what the instancer samples — no separate
    // selection bookkeeping is needed downstream.
    let x = PADDING;
    for (let i = 0; i < row.text.length; i++) {
      const ch = row.text[i];
      const docPos = row.startDocPos + i;
      const inSel = hasRange && docPos >= selFrom && docPos < selTo;
      tctx.fillStyle = inSel ? PAINT_SELECT : PAINT_TEXT;
      tctx.fillText(ch, x, baseline);
      x += tctx.measureText(ch).width;
    }

    // Cursor: a flat block painted in the cursor-category colour. The
    // instancer will lift it into a small pile of glowing pebbles.
    if (r === cursorRowIdx && cursorBlink) {
      const localCol = Math.min(
        Math.max(0, head - row.startDocPos),
        row.text.length,
      );
      const wBefore = tctx.measureText(row.text.slice(0, localCol)).width;
      const cursorChar = localCol < row.text.length ? row.text[localCol] : "";
      const blockWidth = cursorChar
        ? tctx.measureText(cursorChar).width
        : tctx.measureText("M").width * 0.45;
      tctx.fillStyle = PAINT_CURSOR;
      tctx.fillRect(PADDING + wBefore, y + 6, blockWidth, s.size - 4);
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. Stable per-pixel pseudo-random — keyed on (gx, gy) so each
//    stone keeps the same scale, rotation, and jitter across frames.
//    Without this, stones flicker as the canvas re-rasterises.
// ------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function pixelSeed(gx, gy) {
  // Cantor-pair-ish; cheap and collision-free for our grid sizes.
  return (gx * 374761393) ^ (gy * 668265263);
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

// Subtle vertical gradient sky — a large dome lit by the hemisphere
// light only, no shading, so it sits behind everything as a flat
// gradient backdrop.
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

// Plane that the stones sit on — also acts as the (invisible to the
// user, present in the raycaster) hit-test surface for pointer input.
// It's tilted slightly so we read it as a "table" rather than a
// floor.
const PAGE_WIDTH = 5.0;
const PAGE_DEPTH = 5.0;
const pageGroup = new THREE.Group();
// rotate the whole page so it lies almost flat but tipped toward the
// camera; rotation.x = -1.05 rad ≈ 60° down from vertical.
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

// Lighting — warm key from above-right, cool fill from sky, soft
// hemisphere wrap so the underside of each pebble is still readable.
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

// ------------------------------------------------------------------
// 5. InstancedMesh of stones. Capacity is fixed; per-frame we set the
//    matrix and colour of every "live" stone and zero out the rest.
// ------------------------------------------------------------------
const MAX_STONES = 9000;
const stoneGeo = new THREE.IcosahedronGeometry(1.0, 0);
// Squish the icosahedron lightly along its local Y so the stones
// read as pebbles, not perfect orbs.
stoneGeo.scale(1.0, 0.78, 1.0);

const stoneMat = new THREE.MeshStandardMaterial({
  vertexColors: false,
  roughness: 0.85,
  metalness: 0.05,
});
const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, MAX_STONES);
stones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
stones.count = 0;
pageGroup.add(stones);

// Pre-allocate the per-instance colour buffer.
{
  const colors = new Float32Array(MAX_STONES * 3);
  stones.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  stones.instanceColor.setUsage(THREE.DynamicDrawUsage);
}

const dummy = new THREE.Object3D();
const dummyColor = new THREE.Color();
const STONE_RADIUS = (PAGE_WIDTH / TEX) * STRIDE * 0.78;

// Each frame: walk the sampling canvas, place one stone per lit
// pixel (with stable jitter), and update the InstancedMesh.
function rebuildStones() {
  const img = tctx.getImageData(0, 0, TEX, TEX).data;

  let count = 0;
  for (let gy = STRIDE / 2; gy < TEX; gy += STRIDE) {
    for (let gx = STRIDE / 2; gx < TEX; gx += STRIDE) {
      const i = (gy * TEX + gx) * 4;
      const r = img[i];
      const g = img[i + 1];
      const b = img[i + 2];

      // Quick classifier: very dark → text, red-dominant → selection,
      // yellow-ish → cursor, else background (skip).
      let category;
      if (r < 90 && g < 90 && b < 90) {
        category = 0; // text
      } else if (r > 150 && g < 110 && b < 110) {
        category = 1; // selection
      } else if (r > 200 && g > 140 && b < 120) {
        category = 2; // cursor
      } else {
        continue;
      }

      if (count >= MAX_STONES) break;

      // World position from sampling-canvas coordinates.
      const u = gx / TEX;
      const v = gy / TEX;
      const wx = (u - 0.5) * PAGE_WIDTH;
      const wy = -(v - 0.5) * PAGE_DEPTH;

      const seedR = rng(pixelSeed(gx, gy));
      const jx = (seedR() - 0.5) * STONE_RADIUS * 1.4;
      const jy = (seedR() - 0.5) * STONE_RADIUS * 1.4;
      const scale = STONE_RADIUS * (0.55 + seedR() * 0.6);
      const rotZ = seedR() * Math.PI * 2;
      const rotX = (seedR() - 0.5) * 0.8;
      const rotY = (seedR() - 0.5) * 0.8;
      // Lift off the page by a small random amount so stones pile
      // rather than tile.
      const lift = scale * (0.4 + seedR() * 1.1);

      dummy.position.set(wx + jx, wy + jy, lift);
      dummy.rotation.set(rotX, rotY, rotZ);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      stones.setMatrixAt(count, dummy.matrix);

      // Colour: lerp between base and hilite per category by a stable
      // hash so adjacent stones have visible tonal variation.
      const t = seedR();
      let base, hi;
      if (category === 0) {
        base = STONE_TEXT_BASE;
        hi = STONE_TEXT_HILITE;
      } else if (category === 1) {
        base = STONE_SELECT_BASE;
        hi = STONE_SELECT_HILITE;
      } else {
        base = STONE_CURSOR_BASE;
        hi = STONE_CURSOR_HILITE;
      }
      dummyColor.copy(base).lerp(hi, t * 0.7);
      stones.setColorAt(count, dummyColor);

      count++;
    }
    if (count >= MAX_STONES) break;
  }

  stones.count = count;
  stones.instanceMatrix.needsUpdate = true;
  if (stones.instanceColor) stones.instanceColor.needsUpdate = true;
}

// ------------------------------------------------------------------
// 6. Pointer → caret. We raycast the (same) ground plane, recover its
//    UV, and walk visualRows the same way as in demo #01.
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

  setFont(row.style);
  const targetX = Math.max(0, px - PADDING);
  let col = row.text.length;
  let prevW = 0;
  for (let i = 1; i <= row.text.length; i++) {
    const w = tctx.measureText(row.text.slice(0, i)).width;
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
// 7. Resize + animation loop. Wait for Bowlby One before kicking off,
//    otherwise the first frame samples the fallback font and the
//    stones come out anaemic.
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

function tick() {
  if (dirty) {
    renderTexture();
    rebuildStones();
    dirty = false;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Bowlby One"`).then(tick);
