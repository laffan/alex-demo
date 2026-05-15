import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette — used as a fallback while pattern.jpg loads, and as a
//    base tint that the printed pattern sits on.
// ------------------------------------------------------------------
const FABRIC_HEX = "#eeeeee";
const FABRIC_LIT_HEX = "#ffffff";
const FABRIC_SHADE_HEX = "#bdbdbd";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor.
// ------------------------------------------------------------------
const initialDoc = `"Yes, of course, if it's fine tomorrow," said Mrs. Ramsay.`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});
view.focus();

// ------------------------------------------------------------------
// 2. Target atlas — exactly the same role as before: a rasterised
//    "height map" of the document that the cloth simulation springs
//    toward. White pixels = full lift target, black = flat.
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

const PAINT_TEXT = "#ffffff";
const PAINT_SELECT = "rgba(255,255,255,0.5)";

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

      // No visible cursor block — we still record the caret atlas
      // position so the camera-follow can pan toward it, but the
      // user wanted the surface to be the only thing that signals
      // where they are.
      cursorAtlasPx = PADDING + wBefore + blockWidth * 0.5;
      cursorAtlasPy = y + s.size * 0.5;
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js setup — renderer + display scene + sim scene. The sim
//    scene renders into an offscreen float RT that stores the cloth
//    state (R = height, G = velocity). The display scene's mesh
//    samples that RT for vertex displacement.
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

const atlasTex = new THREE.CanvasTexture(texCanvas);
atlasTex.minFilter = THREE.LinearFilter;
atlasTex.magFilter = THREE.LinearFilter;

// ------------------------------------------------------------------
// 4. Cloth simulation — GPU ping-pong between two float RTs at
//    SIM_RES. Each cell stores (height, velocity, _, _). The sim
//    shader computes a damped wave-equation step on the height,
//    forced from below by the rasterised text atlas.
//
//    Why GPU and not JS: even at SIM_RES = 256, a JS sim is 65k
//    cells * 4 neighbour reads per step * several steps per frame.
//    That's ~10 ms of JS work per frame on a fast laptop; on the
//    GPU it's a single fragment shader pass and effectively free.
// ------------------------------------------------------------------
const SIM_RES = 512;
const FLOAT = renderer.capabilities.isWebGL2
  ? THREE.HalfFloatType
  : THREE.FloatType;

function makeRT() {
  return new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, {
    format: THREE.RGBAFormat,
    type: FLOAT,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
let simRtA = makeRT();
let simRtB = makeRT();

// One-time clear both RTs to (0,0,0,1) so the initial state has zero
// height and velocity — saves needing a separate "init" pass.
renderer.setRenderTarget(simRtA);
renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
renderer.clear();
renderer.setRenderTarget(simRtB);
renderer.clear();
renderer.setRenderTarget(null);

const simScene = new THREE.Scene();
const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// Sim shader. Wave-equation step:
//   v_new = v_old + (K_TENSION * laplacian - DAMP * v_old + F_push) * dt
//   h_new = h_old + v_new * dt
// F_push only pushes UP (target - h, clamped >= 0) so the rasterised
// text never *pulls* the cloth — it can only be pushed up from
// below. That's what gives the "letters wedged under the sheet"
// reading rather than "letters embossed into the sheet".
//
// A small constant slump (REST_PULL * h) bleeds energy out of areas
// that have no push, so when a character is deleted the cloth
// gently settles back to flat instead of staying ridged forever.
const simVS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const simFS = /* glsl */ `
  precision highp float;
  uniform sampler2D uPrev;
  uniform sampler2D uTarget;
  uniform float uDt;
  uniform float uTexel;

  // 3x3 gaussian on the atlas — smooths the rasterised glyph edges
  // so the push force isn't a perfect step, and the cloth doesn't
  // get a discontinuity at letter boundaries.
  float sampleTarget(vec2 uv) {
    const float e = 0.0018;
    float t = 0.0;
    t += texture2D(uTarget, uv).r * 0.4;
    t += texture2D(uTarget, uv + vec2( e, 0.0)).r * 0.12;
    t += texture2D(uTarget, uv + vec2(-e, 0.0)).r * 0.12;
    t += texture2D(uTarget, uv + vec2(0.0,  e)).r * 0.12;
    t += texture2D(uTarget, uv + vec2(0.0, -e)).r * 0.12;
    t += texture2D(uTarget, uv + vec2( e,  e)).r * 0.03;
    t += texture2D(uTarget, uv + vec2(-e,  e)).r * 0.03;
    t += texture2D(uTarget, uv + vec2( e, -e)).r * 0.03;
    t += texture2D(uTarget, uv + vec2(-e, -e)).r * 0.03;
    return t;
  }

  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(uPrev, vUv);
    float h = s.r;
    float v = s.g;

    float hL = texture2D(uPrev, vUv + vec2(-uTexel, 0.0)).r;
    float hR = texture2D(uPrev, vUv + vec2( uTexel, 0.0)).r;
    float hU = texture2D(uPrev, vUv + vec2(0.0,  uTexel)).r;
    float hD = texture2D(uPrev, vUv + vec2(0.0, -uTexel)).r;
    float lap = (hL + hR + hU + hD) - 4.0 * h;

    float target = sampleTarget(vUv);
    target = smoothstep(0.10, 0.85, target);

    // Push-only force. The target acts like a rigid object pressed
    // up into the cloth — it can lift the cloth but never pull it
    // below its rest position.
    float push = max(target - h, 0.0);

    // Tension is kept so the cloth reads as taut — the Laplacian
    // coupling pulls neighbouring cells along, which is what makes
    // the displacement bleed slightly past each letter and feel like
    // fabric stretched over a shape, not embossed metal.
    //
    // Damping is set well above the critical value for the coupled
    // system (2*sqrt(K_TENSION + K_PUSH) ≈ 33), so the wave equation
    // degenerates toward a diffusion equation: neighbours still pull
    // on each other but disturbances dissipate before they can
    // oscillate. No visible ripples, but the taut-cloth shape remains.
    float K_TENSION = 300.0;
    float K_PUSH    = 10.0;
    float DAMP      = 60.0;
    float REST_PULL = 0.5;
    float restForce = (target < h) ? -REST_PULL * (h - target) : 0.0;

    float force = K_TENSION * lap + K_PUSH * push + restForce - DAMP * v;
    v += force * uDt;
    h += v * uDt;

    // Clamp to keep things stable under heavy input.
    h = clamp(h, 0.0, 1.4);
    v = clamp(v, -8.0, 8.0);

    gl_FragColor = vec4(h, v, 0.0, 1.0);
  }
`;
const simMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPrev: { value: simRtA.texture },
    uTarget: { value: atlasTex },
    uDt: { value: 1 / 120 },
    uTexel: { value: 1 / SIM_RES },
  },
  vertexShader: simVS,
  fragmentShader: simFS,
  depthTest: false,
  depthWrite: false,
});
const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMaterial);
simScene.add(simQuad);

let simCurrent = simRtA;
let simNext = simRtB;

function stepSim() {
  // Two sub-steps per frame at fixed dt = 1/120 keeps the wave-
  // equation step inside its stability envelope regardless of the
  // browser's frame rate.
  for (let i = 0; i < 2; i++) {
    simMaterial.uniforms.uPrev.value = simCurrent.texture;
    renderer.setRenderTarget(simNext);
    renderer.render(simScene, simCamera);
    renderer.setRenderTarget(null);
    const t = simCurrent;
    simCurrent = simNext;
    simNext = t;
  }
}

// ------------------------------------------------------------------
// 5. Display mesh — high-subdivision plane displaced by the cloth
//    sim. The vertex shader samples the current sim RT, the fragment
//    shader recovers a normal from screen-space derivatives.
// ------------------------------------------------------------------
// A unit plane that we scale per-frame to overflow the viewport.
// MESH_RES is the subdivision count — fixed independent of size so
// the cloth detail stays consistent across monitor shapes.
const MESH_RES = 640;
const planeGeo = new THREE.PlaneGeometry(1, 1, MESH_RES, MESH_RES);

const vertexShader = /* glsl */ `
  uniform sampler2D uCloth;
  uniform float uHeight;
  uniform vec2 uOrigin;
  uniform vec2 uViewSize;

  varying vec3 vWorldPos;
  varying vec2 vAtlasUv;

  void main() {
    vec2 atlasUv = uOrigin + (uv - 0.5) * uViewSize;
    vAtlasUv = atlasUv;
    // Sample the height field directly. The cloth texture's bilinear
    // filter already gives a smooth ramp between sim cells, and any
    // extra Gaussian on top reads as pillowy.
    float h = texture2D(uCloth, atlasUv).r;

    vec3 pos = position;
    pos.z += h * uHeight;

    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uCloth;
  uniform float uHeight;
  uniform vec2 uViewSize;
  uniform vec2 uMeshScale;
  uniform vec3 uFabric;
  uniform vec3 uFabricLit;
  uniform vec3 uFabricShade;
  uniform vec3 uLightDir;
  varying vec3 vWorldPos;
  varying vec2 vAtlasUv;

  // Analytic per-pixel normal from the height field. Sampling at
  // ±2 sim-texels gives a smooth central difference; converting the
  // atlas-uv step to a world-space slope needs the mesh's world size
  // (uMeshScale) and the camera-pan scale (uViewSize), because the
  // plane is stretched to fill the viewport.
  vec3 heightNormal() {
    const float step = 1.0 / 256.0; // 1 cell of SIM_RES = 256
    float hL = texture2D(uCloth, vAtlasUv + vec2(-step, 0.0)).r;
    float hR = texture2D(uCloth, vAtlasUv + vec2( step, 0.0)).r;
    float hD = texture2D(uCloth, vAtlasUv + vec2(0.0, -step)).r;
    float hU = texture2D(uCloth, vAtlasUv + vec2(0.0,  step)).r;
    // dHeight/dWorldX = (hR - hL) / (2*step) * uHeight * uViewSize.x / uMeshScale.x
    float dx = (hR - hL) * uHeight * uViewSize.x / (2.0 * step * uMeshScale.x);
    float dy = (hU - hD) * uHeight * uViewSize.y / (2.0 * step * uMeshScale.y);
    return normalize(vec3(-dx, -dy, 1.0));
  }

  void main() {
    vec3 normal = heightNormal();

    vec3 L = normalize(uLightDir);
    float ndl = dot(normal, L);
    float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);
    float lighting = mix(0.55, 1.10, smoothstep(0.0, 1.0, wrap));

    // Flat tan cloth — no texture sample. The shade/lit gradient over
    // the wrap term still gives the bumps their light/shadow definition.
    vec3 base = mix(uFabricShade, mix(uFabric, uFabricLit, 0.5), wrap);
    vec3 col = base * lighting;

    vec2 centred = (vAtlasUv - 0.5);
    float vig = smoothstep(0.95, 0.25, length(centred));
    col = mix(col * 0.88, col, vig);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uCloth: { value: simCurrent.texture },
    uHeight: { value: 0.085 },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uViewSize: { value: new THREE.Vector2(0.7, 0.7) },
    // World-space size of the plane mesh — pushed in from sizePlane()
    // and used by the fragment shader to convert atlas-uv gradients
    // into world-space height slopes for the analytic normal.
    uMeshScale: { value: new THREE.Vector2(1, 1) },
    uFabric: { value: new THREE.Color(FABRIC_HEX) },
    uFabricLit: { value: new THREE.Color(FABRIC_LIT_HEX) },
    uFabricShade: { value: new THREE.Color(FABRIC_SHADE_HEX) },
    uLightDir: { value: new THREE.Vector3(0.7, 0.65, 0.7).normalize() },
  },
  vertexShader,
  fragmentShader,
});

const mesh = new THREE.Mesh(planeGeo, material);
scene.add(mesh);

// Size the (unit) plane so it just fills the camera frustum at z=0.
// A hair of margin (1.02×) prevents pixel-perfect aspect mismatches
// from showing a one-pixel sliver of the page background at the
// screen edges.
function sizePlane() {
  const vFov = (camera.fov * Math.PI) / 180;
  const visH = 2 * camera.position.z * Math.tan(vFov / 2);
  const visW = visH * camera.aspect;
  mesh.scale.set(visW * 1.02, visH * 1.02, 1);
  material.uniforms.uMeshScale.value.set(visW * 1.02, visH * 1.02);
}

// ------------------------------------------------------------------
// 6. Camera-follow (unchanged from previous version).
// ------------------------------------------------------------------
const viewSize = new THREE.Vector2(0.7, 0.7);
const camOrigin = new THREE.Vector2(0.5, 0.5);

function updateViewSize() {
  const aspect = window.innerWidth / window.innerHeight;
  // Aspect-preserving: viewSize.x / viewSize.y must equal the screen
  // aspect or the (square) atlas pixels render as non-square pixels
  // on screen — earlier we clamped x to 0.98 which made each pixel
  // wider than tall on a widescreen, squashing the text vertically.
  // Past the atlas edges the texture is clamp-to-edge black (cloth
  // stays at rest), so over-scanning x is visually harmless.
  const baseH = 0.96;
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
// 7. Click / drag → caret. Hit-tests the *flat* plane (z=0), not the
//    deformed cloth — the displacement is only ~0.08 units against
//    a 3.4-unit camera distance, so the difference is sub-pixel.
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
// 8. Resize + animation loop.
// ------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  updateViewSize();
  sizePlane();
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

function tick() {
  renderTexture();
  atlasTex.needsUpdate = true;

  stepSim();
  material.uniforms.uCloth.value = simCurrent.texture;

  const t = targetOrigin();
  clampOrigin(t);
  const k = 0.10;
  // Vertical-only follow: the camera glides up and down with the
  // caret but stays horizontally centred so lines never appear to
  // slide sideways as you type.
  camOrigin.x = 0.5;
  camOrigin.y += (t.y - camOrigin.y) * k;
  material.uniforms.uOrigin.value.copy(camOrigin);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`900 ${FONT_SIZE}px "Inter"`).then(() => {
  initCamera();
  tick();
});
