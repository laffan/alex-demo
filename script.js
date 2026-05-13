import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror 6 editor (owns input, selection, history)
// ------------------------------------------------------------------
const initialDoc = `# editor in 3d

a *markdown* editor living
on a **warped plane**.

- type to update the texture
- arrow keys move the cursor
- the text is the light source

\`\`\`
const dream = "code in the void";
\`\`\`

> the screen bends.
> the words remain.`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});

view.focus();
// Pointer handling is set up further down, once the scene + raycaster
// exist (we need the mesh to hit-test against).

// ------------------------------------------------------------------
// 2. Texture canvas — a stylised render of the editor document
// ------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

const FONT_SIZE = 100;
const LINE_HEIGHT = 120;
const PADDING = 80;
const FONT_FAMILY =
  '"SF Mono", "JetBrains Mono", "Menlo", "Monaco", "Consolas", monospace';

let cursorBlink = true;
setInterval(() => {
  cursorBlink = !cursorBlink;
}, 530);

let scrollTopLine = 0;

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

function renderTexture() {
  tctx.fillStyle = "#000";
  tctx.fillRect(0, 0, TEX, TEX);

  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const head = sel.head;
  const selFrom = Math.min(sel.from, sel.to);
  const selTo = Math.max(sel.from, sel.to);
  const hasRange = selFrom !== selTo;
  const cursorLineInfo = doc.lineAt(head);
  const cursorLine = cursorLineInfo.number - 1; // 0-indexed
  const cursorCol = head - cursorLineInfo.from;

  // Keep the cursor visible by scrolling the texture viewport.
  const visibleLines = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
  if (cursorLine < scrollTopLine) scrollTopLine = cursorLine;
  if (cursorLine >= scrollTopLine + visibleLines)
    scrollTopLine = cursorLine - visibleLines + 1;
  if (scrollTopLine < 0) scrollTopLine = 0;

  // Faint border so the plane has a recognisable frame.
  tctx.strokeStyle = "rgba(255,255,255,0.35)";
  tctx.lineWidth = 6;
  tctx.strokeRect(20, 20, TEX - 40, TEX - 40);

  tctx.textBaseline = "alphabetic";

  let y = PADDING;
  for (let i = scrollTopLine + 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const s = lineStyle(line.text);
    setFont(s);

    const baseline = y + s.size * 0.85;

    if (s.bar) {
      tctx.fillStyle = "#fff";
      tctx.fillRect(PADDING - 30, y + 8, 8, s.size - 16);
    }

    // Selection highlight on this line.
    if (hasRange && selFrom <= line.to && selTo >= line.from) {
      const startCol = Math.max(0, selFrom - line.from);
      const endCol = Math.min(line.text.length, selTo - line.from);
      const x1 = PADDING + tctx.measureText(line.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(line.text.slice(0, endCol)).width;
      const extendsPastEol = selTo > line.to;
      const xEnd = extendsPastEol ? TEX - PADDING : Math.max(x2, x1 + 12);
      tctx.fillStyle = "rgba(255,255,255,0.28)";
      tctx.fillRect(x1, y + 4, xEnd - x1, s.size);
    }

    tctx.fillStyle = "#fff";
    tctx.fillText(line.text, PADDING, baseline);

    // Cursor caret
    if (i - 1 === cursorLine && cursorBlink) {
      const w = tctx.measureText(line.text.slice(0, cursorCol)).width;
      tctx.fillStyle = "#fff";
      tctx.fillRect(PADDING + w, y + 6, 6, s.size - 4);
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js: warped plane sampling the texture
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 4.2);

const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

const geometry = new THREE.PlaneGeometry(3.2, 3.2, 192, 192);

// Two-pass domain-warped vertex displacement. Each pass of warp() is a
// pair of sin/cos terms cross-mixing the input coordinates; we feed the
// first pass's output into the second so the output is "warp of a warp"
// rather than a single ripple. The result + a couple of slow underlying
// waves goes into pos.z, giving the plane a floaty, organic bend that
// stays readable through the text.
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

const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  varying vec2 vUv;
  varying float vWarp;

  void main() {
    vec3 col = texture2D(uTex, vUv).rgb;
    float l = dot(col, vec3(0.299, 0.587, 0.114));

    // Subtle vignette
    float v = smoothstep(0.95, 0.15, length(vUv - 0.5));
    l *= 0.55 + 0.45 * v;

    // Brighten ridges, darken troughs — gives the warp a physical feel.
    l *= 1.0 + vWarp * 1.2;

    gl_FragColor = vec4(vec3(l), 1.0);
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
// Raycasting hits the un-warped CPU geometry, not the GPU-displaced
// surface, so the mapping is approximate near the steepest parts of
// the warp — but good enough that clicks land on the intended word.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// Convert a screen-space pointer event into a CodeMirror document
// position, by raycasting the pointer onto the plane, mapping the
// hit's UV back into the texture canvas, then reusing the same
// per-line font logic the renderer uses to pick a column.
function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh);
  if (!hits.length || !hits[0].uv) return null;

  const uv = hits[0].uv;
  // The texture is uploaded with flipY = true (three.js default for
  // CanvasTexture), so uv.y = 1 corresponds to canvas y = 0.
  const px = uv.x * TEX;
  const py = (1 - uv.y) * TEX;

  const doc = view.state.doc;

  // Pixel y -> visible row -> doc line number.
  const row = Math.floor((py - PADDING) / LINE_HEIGHT);
  let lineNumber = scrollTopLine + 1 + row;
  if (lineNumber < 1) lineNumber = 1;
  if (lineNumber > doc.lines) lineNumber = doc.lines;
  const line = doc.line(lineNumber);

  // Pixel x -> column. Set the same font this line is drawn with,
  // then walk characters until the cumulative width passes the click.
  setFont(lineStyle(line.text));
  const targetX = Math.max(0, px - PADDING);
  let col = line.text.length;
  let prevW = 0;
  for (let i = 1; i <= line.text.length; i++) {
    const w = tctx.measureText(line.text.slice(0, i)).width;
    // Snap to whichever side of this glyph's midpoint the click fell on.
    if (targetX < (prevW + w) / 2) {
      col = i - 1;
      break;
    }
    prevW = w;
  }

  return line.from + col;
}

let dragging = false;
let dragAnchor = 0;

const stageEl = document.getElementById("stage");

stageEl.addEventListener("pointerdown", (e) => {
  const pos = docPosFromPointer(e);
  if (pos !== null) {
    dragAnchor = pos;
    dragging = true;
    stageEl.setPointerCapture(e.pointerId);
    view.dispatch({ selection: { anchor: pos, head: pos } });
  }
  view.focus();
});

stageEl.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const pos = docPosFromPointer(e);
  if (pos === null) return;
  view.dispatch({ selection: { anchor: dragAnchor, head: pos } });
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try {
    stageEl.releasePointerCapture(e.pointerId);
  } catch {}
}
stageEl.addEventListener("pointerup", endDrag);
stageEl.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------------
// 5. Resize + animation loop
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
tick();
