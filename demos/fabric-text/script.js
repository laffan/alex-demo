import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette — fabric and shadow only. Letters are bumps, never
//    colour: the only thing that distinguishes glyphs from page is
//    the way light catches their displaced surface.
// ------------------------------------------------------------------
const FABRIC_HEX = "#ecdcc6";       // the flat colour of unstressed fabric
const FABRIC_LIT_HEX = "#fbf4e6";   // light side of a raised bump
const FABRIC_SHADE_HEX = "#bda88c"; // shadow side of a raised bump

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor.
// ------------------------------------------------------------------
const initialDoc = `UNDER THE FABRIC

The shapes you type are
geometry — small ridges
of letterform — pulling
the cloth taut. Light
catches the ridges and
shadow falls behind.

Type. Drag to select.`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});
view.focus();

// ------------------------------------------------------------------
// 2. Height-field atlas.
//
//    The fabric pass treats this canvas as a single-channel height
//    map: white = full lift, black = flat fabric. Painting in tones
//    of grey gives proportional lift, which we use to make the
//    selection a softer rise than the letters themselves.
// ------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

const FONT_SIZE = 200;
const LINE_HEIGHT = 260;
const PADDING = 160;
const FONT_FAMILY = '"Inter", sans-serif';

// Per-pixel intensities painted into the height atlas.
const PAINT_TEXT = "#ffffff";          // glyphs — full lift
const PAINT_CURSOR = "#ffffff";        // cursor block — same lift as glyphs
const PAINT_SELECT = "rgba(255,255,255,0.5)"; // selection rectangle — half lift

let cursorBlink = true;
setInterval(() => {
  cursorBlink = !cursorBlink;
}, 530);

let scrollTopRow = 0;
let visualRows = [];
let cursorAtlasPx = PADDING;
let cursorAtlasPy = PADDING;

function lineStyle(text) {
  const h = /^(#{1,6})\s+/.exec(text);
  if (h) {
    const level = h[1].length;
    return {
      weight: "900",
      size: Math.max(FONT_SIZE - (level - 1) * 18, FONT_SIZE - 60),
      bar: false,
    };
  }
  if (/^>\s?/.test(text)) {
    return { weight: "900", size: FONT_SIZE, bar: true };
  }
  return { weight: "900", size: FONT_SIZE, bar: false };
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
      tctx.fillStyle = PAINT_TEXT;
      tctx.fillRect(PADDING - 50, y + 16, 16, s.size - 32);
    }

    // Selection: a soft half-lift rectangle behind the selected
    // glyphs. The fabric shader sees this as a gentle plateau the
    // letters sit on, which makes the selection read as a slightly
    // raised band of fabric — not as a colour change.
    if (hasRange && selTo > row.startDocPos && selFrom <= row.endDocPos) {
      const startCol = Math.max(0, selFrom - row.startDocPos);
      const endCol = Math.min(row.text.length, selTo - row.startDocPos);
      const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
      const extendsPastRow = selTo > row.endDocPos;
      const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 20);
      tctx.fillStyle = PAINT_SELECT;
      tctx.fillRect(x1, y, xEnd - x1, s.size + 16);
    }

    tctx.fillStyle = PAINT_TEXT;
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

      // Record caret atlas position unconditionally so the camera
      // pan (below) doesn't pulse with the blink.
      cursorAtlasPx = PADDING + wBefore + blockWidth * 0.5;
      cursorAtlasPy = y + s.size * 0.5;

      if (cursorBlink) {
        tctx.fillStyle = PAINT_CURSOR;
        tctx.fillRect(PADDING + wBefore, y + 14, blockWidth, s.size - 14);
      }
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js: a high-subdivision plane lifted in z by the atlas.
//
//    The vertex shader samples the atlas through a 9-tap gaussian
//    blur — that's what gives the fabric a draped, taut feel rather
//    than a pixel-quantised "bristly" silhouette. The fragment
//    shader computes normals from screen-space derivatives of world
//    position, then shades with raking light.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(FABRIC_HEX);

const camera = new THREE.PerspectiveCamera(
  38,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 3.4);
camera.lookAt(0, 0, 0);

const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

// The plane lies in XY (its default), facing the camera at +Z.
// Vertices are displaced along +Z, so bumps protrude toward the
// viewer. A 320² subdivision is enough that even raking light
// reveals only fabric ripples, not triangle facets.
const PLANE = 3.2;
const planeGeo = new THREE.PlaneGeometry(PLANE, PLANE, 320, 320);

const vertexShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform float uHeight;
  uniform vec2 uOrigin;
  uniform vec2 uViewSize;

  varying vec3 vWorldPos;
  varying vec2 vAtlasUv;

  // 9-tap gaussian on the height atlas. Kernel ~0.006 atlas units
  // — a fraction over half a glyph stem width at FONT_SIZE 200 on
  // a 2048 atlas. Big enough to soften letter edges into draped
  // slopes; small enough that the letterform stays recognisable.
  float sampleH(vec2 uv) {
    const float e = 0.006;
    float h = 0.0;
    h += texture2D(uTex, uv + vec2(-e, -e)).r * 0.0625;
    h += texture2D(uTex, uv + vec2( 0.0, -e)).r * 0.125;
    h += texture2D(uTex, uv + vec2( e, -e)).r * 0.0625;
    h += texture2D(uTex, uv + vec2(-e,  0.0)).r * 0.125;
    h += texture2D(uTex, uv                  ).r * 0.25;
    h += texture2D(uTex, uv + vec2( e,  0.0)).r * 0.125;
    h += texture2D(uTex, uv + vec2(-e,  e)).r * 0.0625;
    h += texture2D(uTex, uv + vec2( 0.0,  e)).r * 0.125;
    h += texture2D(uTex, uv + vec2( e,  e)).r * 0.0625;
    return h;
  }

  void main() {
    // Map the plane's UV to a window of the atlas: like cloud-text,
    // we pan and zoom so the camera follows the caret.
    vec2 atlasUv = uOrigin + (uv - 0.5) * uViewSize;
    vAtlasUv = atlasUv;

    float h = sampleH(atlasUv);
    // A subtle smoothstep — flat areas stay flat, letter peaks round
    // off. Without it the height map's anti-aliased edges read as
    // tiny corrugations under raking light.
    h = smoothstep(0.04, 0.92, h);

    vec3 pos = position;
    pos.z += h * uHeight;

    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform vec3 uFabric;
  uniform vec3 uFabricLit;
  uniform vec3 uFabricShade;
  uniform vec3 uLightDir;
  uniform vec2 uViewSize;

  varying vec3 vWorldPos;
  varying vec2 vAtlasUv;

  // Subtle weave noise — broken up so the flat fabric isn't dead-
  // flat off the bumps. Single value-noise tap, dirt cheap.
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vn(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    // Normal from screen-space derivatives of world position. This
    // is the standard "free normal" trick: dFdx + dFdy + cross gives
    // a per-fragment normal that matches the displaced surface, with
    // no extra texture taps or vertex-side normal computation. It is
    // a bit faceted in screen space but with this many subdivisions
    // it reads as smooth fabric.
    vec3 dPdx = dFdx(vWorldPos);
    vec3 dPdy = dFdy(vWorldPos);
    vec3 normal = normalize(cross(dPdx, dPdy));

    vec3 L = normalize(uLightDir);

    // Wrap shading: a softened dot(N, L) that lets the back-of-bump
    // still receive some light, like real fabric does. Pure Lambert
    // gives an unsettlingly hard line on the shadow side.
    float ndl = dot(normal, L);
    float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);

    // Three-tone shading: shadow, mid (fabric), lit. Mixing at two
    // breakpoints lets us hold the off-white as the dominant tone
    // while still pushing into nearly-white on the front of bumps.
    vec3 col = mix(uFabricShade, uFabric, smoothstep(0.0, 0.55, wrap));
    col = mix(col, uFabricLit, smoothstep(0.55, 1.0, wrap));

    // Tiny per-pixel weave noise — varies the local tone by ±0.015
    // so the fabric stops looking like solid plastic.
    float weave = vn(gl_FragCoord.xy * 0.6);
    col += (weave - 0.5) * 0.018;

    // Soft vignette so the page edges fall into shadow rather than
    // hard-cutting against the body background.
    vec2 centred = (vAtlasUv - 0.5);
    float vig = smoothstep(0.85, 0.25, length(centred));
    col = mix(col * 0.92, col, vig);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTex: { value: texture },
    uHeight: { value: 0.075 }, // displacement amount in world units
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uViewSize: { value: new THREE.Vector2(0.7, 0.7) },
    uFabric: { value: new THREE.Color(FABRIC_HEX) },
    uFabricLit: { value: new THREE.Color(FABRIC_LIT_HEX) },
    uFabricShade: { value: new THREE.Color(FABRIC_SHADE_HEX) },
    uLightDir: { value: new THREE.Vector3(0.7, 0.65, 0.7).normalize() },
  },
  vertexShader,
  fragmentShader,
  // We use dFdx / dFdy in the fragment shader. WebGL 2 includes
  // them; WebGL 1 needs the extension enabled.
  extensions: { derivatives: true },
});

const mesh = new THREE.Mesh(planeGeo, material);
scene.add(mesh);

// ------------------------------------------------------------------
// 4. Camera-follow (same idea as cloud-text). The visible window
//    is wide enough to read several lines at once; we just glide
//    the pan when the caret wanders near a viewport edge.
// ------------------------------------------------------------------
const viewSize = new THREE.Vector2(0.7, 0.7);
const camOrigin = new THREE.Vector2(0.5, 0.5);

function updateViewSize() {
  const aspect = window.innerWidth / window.innerHeight;
  // Wider on landscape monitors so a sentence reads in one go.
  const baseH = 0.78;
  viewSize.set(Math.min(0.96, baseH * aspect), Math.min(0.96, baseH));
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
// 5. Click / drag → caret. Plane is at z=0 in world space; we just
//    raycast it and undo the pan/zoom to get atlas pixels.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh);
  if (!hits.length || !hits[0].uv) return null;

  const uv = hits[0].uv; // plane UV — same as the shader's `uv`
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
}
window.addEventListener("resize", resize);
resize();

function initCamera() {
  renderTexture();
  const t = targetOrigin();
  clampOrigin(t);
  camOrigin.copy(t);
  material.uniforms.uOrigin.value.copy(camOrigin);
}

function tick() {
  renderTexture();
  texture.needsUpdate = true;

  const t = targetOrigin();
  clampOrigin(t);
  const k = 0.10;
  camOrigin.x += (t.x - camOrigin.x) * k;
  camOrigin.y += (t.y - camOrigin.y) * k;
  material.uniforms.uOrigin.value.copy(camOrigin);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`900 ${FONT_SIZE}px "Inter"`).then(() => {
  initCamera();
  tick();
});
