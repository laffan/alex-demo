import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette — pale ivory text on dark slate.
// ------------------------------------------------------------------
const BG_HEX = "#272a2e";
const FG_HEX = "#e8e2d3";
const SELECTION_RGBA = "rgba(232, 226, 211, 0.22)";
const BORDER_RGBA = "rgba(232, 226, 211, 0.18)";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror 6 editor (owns input, selection, history)
// ------------------------------------------------------------------
const initialDoc = `Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, “and what is the use of a book,” thought Alice “without pictures or conversations?”`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Texture canvas — a stylised render of the editor document.
// ------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

const FONT_SIZE = 100;
const LINE_HEIGHT = 118;
const PADDING = 240;
const FONT_FAMILY = '"Trocchi", Georgia, serif';

let cursorBlink = true;
setInterval(() => {
  cursorBlink = !cursorBlink;
}, 530);

// The viewport is expressed in *visual* rows (post-wrap), not logical
// lines, because one CodeMirror line can wrap to many texture rows.
let scrollTopRow = 0;
// Rebuilt every frame; click handlers also use it for hit testing.
let visualRows = [];

function lineStyle(text) {
  const h = /^(#{1,6})\s+/.exec(text);
  if (h) {
    const level = h[1].length;
    return {
      weight: "700",
      style: "normal",
      size: Math.max(FONT_SIZE - (level - 1) * 10, FONT_SIZE - 30),
      bar: false,
    };
  }
  if (/^```/.test(text)) {
    return { weight: "400", style: "italic", size: FONT_SIZE, bar: false };
  }
  if (/^>\s?/.test(text)) {
    return { weight: "400", style: "normal", size: FONT_SIZE, bar: true };
  }
  return { weight: "400", style: "normal", size: FONT_SIZE, bar: false };
}

function setFont(s) {
  tctx.font = `${s.style} ${s.weight} ${s.size}px ${FONT_FAMILY}`;
}

// Greedy word wrap. Returns segments [{text, startCol}] where startCol
// is the column index in the logical line at which the segment starts —
// keeping that index lets caret / selection / hit-testing math walk
// between logical and visual coordinates without any extra bookkeeping.
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

// Among rows whose doc range covers `head`, pick the *last* — that way
// a cursor sitting exactly on a wrap break renders on the new visual
// row (where the next typed character will actually appear) rather
// than at the trailing-space end of the previous row.
function findCursorRow(rows, head) {
  let best = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.startDocPos <= head && head <= r.endDocPos) {
      best = i;
    } else if (r.startDocPos > head) {
      break;
    }
  }
  return best;
}

function renderTexture() {
  tctx.fillStyle = BG_HEX;
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

  // Faint border so the plane has a recognisable frame against the
  // (same-coloured) page background.
  tctx.strokeStyle = BORDER_RGBA;
  tctx.lineWidth = 6;
  tctx.strokeRect(20, 20, TEX - 40, TEX - 40);

  tctx.textBaseline = "alphabetic";

  let y = PADDING;
  for (let r = scrollTopRow; r < visualRows.length; r++) {
    const row = visualRows[r];
    const s = row.style;
    setFont(s);
    const baseline = y + s.size * 0.85;

    if (s.bar && row.isFirstInLine) {
      tctx.fillStyle = FG_HEX;
      tctx.fillRect(PADDING - 30, y + 8, 8, s.size - 16);
    }

    // Selection highlight covers the overlap of [selFrom, selTo] with
    // this row's doc range; if the selection spills past this row's
    // end-of-row, extend the rect to the right edge so the highlight
    // flows visually across the wrap break.
    if (hasRange && selTo > row.startDocPos && selFrom <= row.endDocPos) {
      const startCol = Math.max(0, selFrom - row.startDocPos);
      const endCol = Math.min(row.text.length, selTo - row.startDocPos);
      const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
      const extendsPastRow = selTo > row.endDocPos;
      const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 12);
      tctx.fillStyle = SELECTION_RGBA;
      tctx.fillRect(x1, y + 4, xEnd - x1, s.size);
    }

    tctx.fillStyle = FG_HEX;
    tctx.fillText(row.text, PADDING, baseline);

    if (r === cursorRowIdx && cursorBlink) {
      const localCol = Math.min(
        Math.max(0, head - row.startDocPos),
        row.text.length,
      );
      const wBefore = tctx.measureText(row.text.slice(0, localCol)).width;
      const cursorChar = localCol < row.text.length ? row.text[localCol] : "";
      const blockWidth = cursorChar
        ? tctx.measureText(cursorChar).width
        : tctx.measureText("M").width * 0.55;
      tctx.fillStyle = FG_HEX;
      tctx.fillRect(PADDING + wBefore, y + 6, blockWidth, s.size - 4);
      if (cursorChar) {
        tctx.fillStyle = BG_HEX;
        tctx.fillText(cursorChar, PADDING + wBefore, baseline);
      }
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js: warped plane sampling the texture.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_HEX);

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 4.8);

const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

const geometry = new THREE.PlaneGeometry(3.2, 3.2, 192, 192);

// Two-pass sin/cos domain warp — see the README for the design notes.
const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vWarp;

  vec2 warp(vec2 p, float t) {
    vec2 q = vec2(
      sin(p.y * 1.7 + t * 0.6) + cos(p.x * 1.3 - t * 0.4),
      sin(p.x * 1.9 - t * 0.5) + cos(p.y * 1.1 + t * 0.7)
    );
    vec2 r = vec2(
      sin(p.x + q.x * 1.4 + t * 0.3),
      cos(p.y + q.y * 1.4 - t * 0.2)
    );
    return r;
  }

  void main() {
    vUv = uv;
    vec3 pos = position;

    vec2 p = pos.xy * 1.2;
    vec2 w1 = warp(p, uTime);
    vec2 w2 = warp(p + w1, uTime * 0.7);
    float h = (w1.x + w2.y) * 0.18
            + sin(pos.x * 2.3 + uTime * 0.8) * 0.06
            + cos(pos.y * 2.1 - uTime * 0.6) * 0.06;

    pos.z += h;
    vWarp = h;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

// Colour-preserving fragment shader. Unlike the original B&W version,
// this one keeps the tan/brown palette intact, applies a soft vignette
// by darkening the edges toward a deeper tan, and uses vWarp to brighten
// ridges and shadow the troughs — text legibility is preserved by
// keeping the multiplier modest and clamping the result.
const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  varying vec2 vUv;
  varying float vWarp;

  void main() {
    vec3 col = texture2D(uTex, vUv).rgb;

    float v = smoothstep(0.95, 0.15, length(vUv - 0.5));
    col *= 0.82 + 0.18 * v;

    col = clamp(col * (1.0 + vWarp * 0.55), 0.0, 1.0);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uTex: { value: texture },
  },
  vertexShader,
  fragmentShader,
  side: THREE.DoubleSide,
});

const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);

// ------------------------------------------------------------------
// 4. Click + drag to move the caret / select text.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh);
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

// preventDefault on pointerdown stops the browser from running its
// default mousedown side effects — most importantly, collapsing any
// active text selection inside the (focused but not clicked)
// contenteditable. Combined with focusing the editor *before* we
// dispatch the selection, this keeps state.selection and the DOM
// Selection in lockstep, so CodeMirror commands like Delete see the
// range we drew rather than a collapsed cursor.
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
  // Re-focus so CodeMirror re-syncs the contenteditable's DOM Selection
  // to state.selection. Without this, the DOM Selection can lag behind
  // the dispatched range and the next keystroke acts on a collapsed
  // cursor.
  view.focus();
}
stageEl.addEventListener("pointerup", endDrag);
stageEl.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------------
// 5. Resize + animation loop (deferred until Trocchi has loaded so
//    the first few frames don't render in a fallback serif).
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
  material.uniforms.uTime.value = clock.getElapsedTime();
  renderTexture();
  texture.needsUpdate = true;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Trocchi"`).then(tick);
