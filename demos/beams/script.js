import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette — dark scene, warm light.
// ------------------------------------------------------------------
const BG_HEX = "#08090d";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor.
// ------------------------------------------------------------------
const initialDoc = `In the beginning God created the heavens and the earth.`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});
view.focus();

// ------------------------------------------------------------------
// 2. Text atlas — white glyphs on black. The atlas doubles as the
//    *occlusion buffer* for the god-rays pass: anywhere the atlas is
//    bright, light streams through and radiates away from the sun
//    along the screen-space direction back to the pixel.
// ------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

const FONT_SIZE = 160;
const LINE_HEIGHT = 210;
const PADDING = 180;
const FONT_FAMILY = '"Cormorant Garamond", Georgia, serif';

let cursorBlink = true;
setInterval(() => {
  cursorBlink = !cursorBlink;
}, 530);

let scrollTopRow = 0;
let visualRows = [];
let cursorAtlasPx = TEX * 0.5;
let cursorAtlasPy = TEX * 0.5;

function lineStyle(text) {
  const h = /^(#{1,6})\s+/.exec(text);
  if (h) {
    const level = h[1].length;
    return {
      weight: "700",
      size: Math.max(FONT_SIZE - (level - 1) * 20, FONT_SIZE - 60),
      bar: false,
    };
  }
  if (/^>\s?/.test(text)) {
    return { weight: "700", size: FONT_SIZE, bar: true };
  }
  return { weight: "700", size: FONT_SIZE, bar: false };
}

function setFont(s) {
  tctx.font = `${s.weight} ${s.size}px ${FONT_FAMILY}`;
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
  tctx.fillStyle = "#000";
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
      tctx.fillStyle = "#ffffff";
      tctx.fillRect(PADDING - 50, y + 16, 14, s.size - 32);
    }

    // Selection paints into the blue channel so the shader can tint
    // those rays a different colour without changing their shape.
    if (hasRange && selTo > row.startDocPos && selFrom <= row.endDocPos) {
      const startCol = Math.max(0, selFrom - row.startDocPos);
      const endCol = Math.min(row.text.length, selTo - row.startDocPos);
      const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
      const extendsPastRow = selTo > row.endDocPos;
      const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 20);
      tctx.fillStyle = "#3366ff";
      tctx.fillRect(x1, y, xEnd - x1, s.size + 16);
    }

    tctx.fillStyle = "#ffffff";
    tctx.fillText(row.text, PADDING, baseline);

    if (r === cursorRowIdx) {
      const localCol = Math.min(
        Math.max(0, head - row.startDocPos),
        row.text.length,
      );
      const wBefore = tctx.measureText(row.text.slice(0, localCol)).width;
      const cursorChar = localCol < row.text.length ? row.text[localCol] : "";
      const blockWidth = cursorChar
        ? tctx.measureText(cursorChar).width
        : tctx.measureText("M").width * 0.55;

      cursorAtlasPx = PADDING + wBefore + blockWidth * 0.5;
      cursorAtlasPy = y + s.size * 0.5;

      if (cursorBlink) {
        tctx.fillStyle = "#ffffff";
        tctx.fillRect(PADDING + wBefore, y + 20, blockWidth, s.size - 24);
      }
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js — single fullscreen-plane shader. The shader does the
//    work of the classic three.js godrays postprocessing example
//    (radial blur of an occlusion buffer toward a sun point) but
//    folded into one pass since our "occluder" *is* the atlas, no
//    geometry to render first. Sampled multiple times along the
//    line from each pixel back to the sun, accumulating bright atlas
//    pixels with exponential decay — the same loop the three.js
//    GodRaysGenerateShader runs over its three blur passes, just
//    rolled into one.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_HEX);

// Camera placement mirrors the undulating-surface demo (z = 4.8,
// fov = 42) — a comfortably wide view of the whole page rather than
// a tight crop.
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 4.8);
camera.lookAt(0, 0, 0);

const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.wrapS = THREE.ClampToEdgeWrapping;
texture.wrapT = THREE.ClampToEdgeWrapping;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Godrays fragment shader. atlasUv is computed from screen uv by the
// same uOrigin/uViewSize transform the other demos use for camera
// pan — so the "sun" sits in screen space while the text it lights
// pans underneath as the caret moves.
//
// The radial-blur loop samples the atlas at SAMPLES points along the
// ray from the current pixel back to the sun. Each sample is
// attenuated by `illum * weight` and `illum` decays geometrically
// per step, so distant samples contribute less than near ones. The
// net effect: any bright atlas pixel between this pixel and the sun
// "leaves a streak" along its line to the sun.
const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform float uTime;
  uniform vec2 uOrigin;
  uniform vec2 uViewSize;
  uniform vec2 uSun;          // in screen-space uv (0..1)
  uniform vec3 uBeamColor;
  uniform vec3 uSelectColor;
  uniform vec3 uBgTop;
  uniform vec3 uBgBottom;
  uniform float uAspect;

  varying vec2 vUv;

  // Map a screen-space uv into atlas-space uv via the camera-pan
  // transform shared with the other demos.
  vec2 screenToAtlas(vec2 sUv) {
    return uOrigin + (sUv - 0.5) * uViewSize;
  }

  vec4 sampleAtlas(vec2 sUv) {
    vec2 aUv = screenToAtlas(sUv);
    if (aUv.x < 0.0 || aUv.x > 1.0 || aUv.y < 0.0 || aUv.y > 1.0) {
      return vec4(0.0);
    }
    return texture2D(uTex, aUv);
  }

  // Soft sample at the atlas — broadens the bright source slightly
  // so each glyph has a small halo even before the god rays run.
  vec4 softAtlas(vec2 sUv) {
    float e = 0.003;
    vec4 v = sampleAtlas(sUv) * 0.4;
    v += sampleAtlas(sUv + vec2( e, 0.0)) * 0.15;
    v += sampleAtlas(sUv + vec2(-e, 0.0)) * 0.15;
    v += sampleAtlas(sUv + vec2(0.0,  e)) * 0.15;
    v += sampleAtlas(sUv + vec2(0.0, -e)) * 0.15;
    return v;
  }

  // Hash for jitter — stops the discrete samples banding into a
  // visible staircase along the rays.
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Radial blur from current pixel back toward sun. Returns
  // (glyph rays, selection rays) so the two can be tinted
  // differently.
  vec2 godRays(vec2 sUv) {
    const int SAMPLES = 80;
    float density = 0.92;
    float decay = 0.965;
    float weight = 0.045;

    vec2 delta = (sUv - uSun) * density / float(SAMPLES);
    vec2 cur = sUv;
    float white = 0.0;
    float blue = 0.0;
    float illum = 1.0;
    // Per-pixel jitter so neighbouring screen pixels sample at
    // slightly different phases — softens any residual banding.
    float j = hash12(gl_FragCoord.xy + uTime);
    cur -= delta * j;

    for (int i = 0; i < SAMPLES; i++) {
      vec4 s = softAtlas(cur);
      white += s.r * illum * weight;
      blue  += s.b * illum * weight;
      illum *= decay;
      cur -= delta;
    }
    return vec2(white, blue);
  }

  void main() {
    vec2 sUv = vUv;

    // Sky-style vertical gradient. Slight horizontal tilt of the
    // gradient axis gives the scene a feel that the light is
    // raking in from the upper-left, matching the sun position.
    float gradT = clamp(sUv.y - (sUv.x - 0.5) * 0.05, 0.0, 1.0);
    vec3 bg = mix(uBgBottom, uBgTop, gradT);

    // Direct atlas — keeps the letters readable as crisp text on
    // top of the diffused rays.
    vec4 direct = sampleAtlas(sUv);
    vec3 textCol = uBeamColor * direct.r + uSelectColor * direct.b;

    // Soft halo: a small radius of atlas around the pixel. This is
    // the "bloom-around-each-letter" layer.
    vec4 halo = softAtlas(sUv);
    vec3 haloCol = uBeamColor * halo.r * 0.6 + uSelectColor * halo.b * 0.6;

    // The big radial-blur godrays.
    vec2 rays = godRays(sUv);
    vec3 rayCol = uBeamColor * rays.x + uSelectColor * rays.y;

    // Distance-from-sun falloff. Pixels close to the sun get the
    // brightest beam contribution; pixels at the bottom of the
    // screen still receive some, but dimmed.
    vec2 toSun = sUv - uSun;
    toSun.x *= uAspect; // correct for non-square viewport
    float distSun = length(toSun);
    float beamFalloff = exp(-distSun * 0.6);

    vec3 col = bg;
    col += rayCol * (0.9 + beamFalloff * 1.4);
    col += haloCol * 1.2;
    col += textCol * 1.4;

    // Subtle vignette toward the corners so the eye is drawn to the
    // text without the edges of the viewport feeling overly bright.
    float vig = smoothstep(1.25, 0.35, length((sUv - 0.5) * vec2(uAspect, 1.0)));
    col *= 0.78 + 0.22 * vig;

    // Soft Reinhard tonemap so accumulated rays don't blow out.
    col = col / (col + vec3(0.85));

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTex: { value: texture },
    uTime: { value: 0 },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uViewSize: { value: new THREE.Vector2(0.7, 0.7) },
    // Sun a touch above and left of centre — gives the rays an
    // angled, diagonal cast rather than a perfectly symmetric
    // starburst.
    uSun: { value: new THREE.Vector2(0.38, 1.18) },
    uBeamColor: { value: new THREE.Color("#ffe2a0") },
    uSelectColor: { value: new THREE.Color("#88b6ff") },
    uBgTop: { value: new THREE.Color("#0a1326") },
    uBgBottom: { value: new THREE.Color("#03040a") },
    uAspect: { value: 1 },
  },
  vertexShader,
  fragmentShader,
  depthWrite: false,
});

// A unit plane scaled per-frame to fill the camera frustum, same as
// the other demos. The shader does everything in screen-uv space, so
// the plane is just there to give every fragment a chance to run.
const planeGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
const mesh = new THREE.Mesh(planeGeo, material);
scene.add(mesh);

function sizePlane() {
  const vFov = (camera.fov * Math.PI) / 180;
  const visH = 2 * camera.position.z * Math.tan(vFov / 2);
  const visW = visH * camera.aspect;
  // Slight overscan so a wide-aspect window never reveals the
  // plane's edge.
  mesh.scale.set(visW * 1.02, visH * 1.02, 1);
}

// ------------------------------------------------------------------
// 4. Camera-follow — vertical only, like the other (post-update)
//    demos. The sun stays glued to screen space; the document slides
//    underneath as the caret moves down.
// ------------------------------------------------------------------
const viewSize = new THREE.Vector2(0.7, 0.7);
const camOrigin = new THREE.Vector2(0.5, 0.5);

function updateViewSize() {
  const aspect = window.innerWidth / window.innerHeight;
  // Aspect-preserving: viewSize.x / viewSize.y must equal the screen
  // aspect or square atlas pixels render as non-square pixels on
  // screen, squashing the text. Past the atlas edge the texture is
  // clamp-to-edge black, which is what the dark scene wants anyway.
  const baseH = 0.95;
  viewSize.set(baseH * aspect, baseH);
  material.uniforms.uViewSize.value.copy(viewSize);
}

function clampOrigin(o) {
  const halfW = viewSize.x * 0.5;
  const halfH = viewSize.y * 0.5;
  if (halfW > 0.5) o.x = 0.5;
  else o.x = Math.min(Math.max(o.x, halfW), 1 - halfW);
  if (halfH > 0.5) o.y = 0.5;
  else o.y = Math.min(Math.max(o.y, halfH), 1 - halfH);
}

function targetOrigin() {
  return new THREE.Vector2(cursorAtlasPx / TEX, 1 - cursorAtlasPy / TEX);
}

// ------------------------------------------------------------------
// 5. Click + drag → caret. Hit-test the flat plane in screen space.
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
  const atlasU = camOrigin.x + (uv.x - 0.5) * viewSize.x;
  const atlasV = camOrigin.y + (uv.y - 0.5) * viewSize.y;
  const px = atlasU * TEX;
  const py = (1 - atlasV) * TEX;

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
// 6. Resize + animation loop.
// ------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  updateViewSize();
  sizePlane();
  material.uniforms.uAspect.value = w / h;
}
window.addEventListener("resize", resize);
resize();

function initCamera() {
  renderTexture();
  const t = targetOrigin();
  clampOrigin(t);
  camOrigin.x = 0.5;
  camOrigin.y = t.y;
  material.uniforms.uOrigin.value.copy(camOrigin);
}

const clock = new THREE.Clock();
function tick() {
  material.uniforms.uTime.value = clock.getElapsedTime();
  renderTexture();
  texture.needsUpdate = true;

  const t = targetOrigin();
  clampOrigin(t);
  // Vertical-only follow — same pattern as fabric-text.
  camOrigin.x = 0.5;
  camOrigin.y += (t.y - camOrigin.y) * 0.10;
  material.uniforms.uOrigin.value.copy(camOrigin);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`700 ${FONT_SIZE}px "Cormorant Garamond"`).then(() => {
  initCamera();
  tick();
});
