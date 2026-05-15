import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette.
// ------------------------------------------------------------------
const BG_HEX = "#05060a";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor.
// ------------------------------------------------------------------
const initialDoc = `A salesman who shared his liquor and steered while sleeping`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Text atlas — a 2D rasterisation of the document. Used as the
//    XY "shape mask" of the cloud volume: where the atlas is white,
//    the volume has density; where it's black, the volume is empty.
// ------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

const FONT_SIZE = 160;
const LINE_HEIGHT = 200;
const PADDING = 160;
const FONT_FAMILY = '"Archivo Black", "Inter", sans-serif';

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
      weight: "900",
      size: Math.max(FONT_SIZE - (level - 1) * 24, FONT_SIZE - 70),
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

// We paint into R for glyphs/cursor and B for selection. The
// raymarch reads R as "main cloud density" and B as a tint shift —
// it doesn't need separate channels for cursor vs glyph, the cursor
// is just bright white that blinks in/out.
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
      tctx.fillRect(PADDING - 40, y + 12, 14, s.size - 24);
    }

    if (hasRange && selTo > row.startDocPos && selFrom <= row.endDocPos) {
      const startCol = Math.max(0, selFrom - row.startDocPos);
      const endCol = Math.min(row.text.length, selTo - row.startDocPos);
      const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
      const extendsPastRow = selTo > row.endDocPos;
      const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 30);
      tctx.fillStyle = "#6a86ff";
      tctx.fillRect(x1, y, xEnd - x1, s.size + 20);
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
        tctx.fillStyle = "#aeefff";
        tctx.fillRect(PADDING + wBefore, y + 20, blockWidth, s.size - 20);
      }
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js — a real 3D scene with a slab-shaped Box mesh that
//    bounds the cloud volume. Inspired by the threejs volumetric
//    cloud example (webgl_volume_cloud), but the volume is shaped
//    by the text atlas rather than a sphere: the atlas masks the
//    cloud in XY, and a smooth bell-curve profile bounds it in Z.
//
//    A camera placed in world space looks at the slab from outside;
//    the fragment shader raymarches from camera through the slab,
//    accumulating density and light at each step. Animated 3D noise
//    gives the cloud its puffiness and gentle drift.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_HEX);

const camera = new THREE.PerspectiveCamera(
  38,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 4.0);
camera.lookAt(0, 0, 0);

const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.wrapS = THREE.ClampToEdgeWrapping;
texture.wrapT = THREE.ClampToEdgeWrapping;

// The slab. Sized so it always overflows the camera frustum (the
// box's outer edges are off-screen, so the raymarch covers every
// visible pixel — no sky strips at the sides on wide monitors).
// Z thickness gives the volume a real depth so clouds have a
// "front" and "back" that the camera shades distinctly.
let SLAB_W = 8.0;
let SLAB_H = 8.0;
const SLAB_D = 0.9;
const boxGeo = new THREE.BoxGeometry(1, 1, SLAB_D);

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Raymarching shader. Two nested loops:
//   - outer: STEPS samples along the eye ray inside the slab
//   - inner: LIGHT_STEPS short samples toward the key light, used
//     to attenuate the emission at the outer step
// The cheap fbm noise is 3D-domain — sliced by z so neighbouring
// z values share cloud structure, animated by uTime so the cloud
// drifts. text(x, y) shapes the cloud in XY and a bell-curve in
// z thins it out near the front and back of the slab.
const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform float uTime;
  uniform vec2 uOrigin;
  uniform vec2 uViewSize;
  uniform vec3 uBoxMin;
  uniform vec3 uBoxMax;
  uniform vec3 uLightDir;

  varying vec3 vWorldPos;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }
  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += vnoise3(p) * a;
      p *= 2.07;
      a *= 0.55;
    }
    return v;
  }

  // Heat-shimmer warp. The atlas uv that drives volume density gets
  // displaced by an animated noise field whose amplitude grows toward
  // the back of the slab, so the rear of the cloud ripples more than
  // the front — the same trick that makes asphalt over a hot road
  // look watery, only painted into a volumetric text atlas.
  vec2 wobble(vec2 uv, float zNorm) {
    float t = uTime;
    // Two octaves of cosine ripple, axis-decorrelated so the
    // distortion isn't a simple swirl. The 1.4× amplification
    // toward the back of the slab is what gives the back layers
    // their visible boil.
    float amp = 0.0042 * (0.55 + 1.0 * zNorm);
    float fx = cos(uv.y * 38.0 + t * 1.7) + 0.55 * cos(uv.y * 71.0 - t * 2.3);
    float fy = sin(uv.x * 33.0 - t * 1.4) + 0.55 * sin(uv.x * 67.0 + t * 1.9);
    return uv + vec2(fx, fy) * amp;
  }

  // Sample volume density at world-space point p.
  // - Map p.xy to atlas uv via the camera-pan transform.
  // - Wobble that uv with the heat-shimmer field.
  // - Smooth bell-curve along z so density tapers at front/back.
  // - 3D fbm puffiness, animated by uTime.
  float density(vec3 p) {
    vec2 boxUv = (p.xy - uBoxMin.xy) / (uBoxMax.xy - uBoxMin.xy);
    vec2 atlasUv = uOrigin + (boxUv - 0.5) * uViewSize;
    float zNorm = (p.z - uBoxMin.z) / (uBoxMax.z - uBoxMin.z); // 0..1
    atlasUv = wobble(atlasUv, zNorm);
    if (atlasUv.x < 0.0 || atlasUv.x > 1.0 || atlasUv.y < 0.0 || atlasUv.y > 1.0) {
      return 0.0;
    }
    vec4 tex = texture2D(uTex, atlasUv);
    float text = max(tex.r, tex.b * 0.65);
    if (text < 0.02) return 0.0;

    float zc = zNorm * 2.0 - 1.0; // -1..1
    float profile = exp(-zc * zc * 2.5);

    vec3 np = p * 2.2 + vec3(uTime * 0.05, uTime * 0.03, uTime * 0.12);
    float n = fbm3(np);

    // The noise modulates around 1, so density never drops to 0 inside
    // the glyph — the text always reads as a coherent shape, but with
    // puffy texture instead of a sharp ridge.
    float puff = 0.45 + 0.95 * n;
    return text * profile * puff;
  }

  // March from p toward the light a short way, accumulating density.
  // Result: optical depth → exp(-) gives how much light reaches p.
  float lightMarch(vec3 p) {
    const int LIGHT_STEPS = 4;
    float od = 0.0;
    float step = 0.10;
    for (int i = 0; i < LIGHT_STEPS; i++) {
      p += uLightDir * step;
      od += density(p) * step;
    }
    return exp(-od * 4.5);
  }

  // Ray-AABB intersection. Returns (tNear, tFar); tFar < tNear means miss.
  vec2 rayBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax) {
    vec3 invD = 1.0 / rd;
    vec3 t0 = (bMin - ro) * invD;
    vec3 t1 = (bMax - ro) * invD;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tNear = max(max(tmin.x, tmin.y), tmin.z);
    float tFar  = min(min(tmax.x, tmax.y), tmax.z);
    return vec2(tNear, tFar);
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - cameraPosition);

    vec2 hit = rayBox(ro, rd, uBoxMin, uBoxMax);
    float tNear = max(hit.x, 0.0);
    float tFar = hit.y;
    if (tFar <= tNear) discard;

    // Spatial jitter on the march phase — without it, the discrete
    // STEPS show as bands of constant density. With it, neighbouring
    // pixels sample slightly offset positions and the bands turn
    // into film-grain softness.
    float jitter = hash13(vec3(gl_FragCoord.xy, uTime));

    const int STEPS = 28;
    float dt = (tFar - tNear) / float(STEPS);
    float t = tNear + jitter * dt;

    // Light colour: a warm key plus a cool ambient. The lightMarch
    // gives self-shadowing; the ambient keeps inside-glyph density
    // from going pitch-black.
    vec3 lightCol = vec3(1.0, 0.95, 0.85);
    vec3 ambient = vec3(0.18, 0.20, 0.28);

    vec3 col = vec3(0.0);
    float trans = 1.0;

    for (int s = 0; s < STEPS; s++) {
      vec3 p = ro + rd * t;
      float d = density(p);

      if (d > 0.01) {
        float lt = lightMarch(p);
        vec3 emit = (lightCol * lt + ambient) * d;
        col += trans * emit * dt;
        trans *= exp(-d * dt * 6.0);
        if (trans < 0.02) break;
      }
      t += dt;
    }

    // Background: deep night gradient. Stronger at top, soft at the
    // horizon to give the page a sense of depth.
    vec2 sUv = gl_FragCoord.xy / vec2(textureSize(uTex, 0)) ;
    vec3 bg = mix(vec3(0.018, 0.022, 0.032), vec3(0.06, 0.07, 0.12), 1.0 - gl_FragCoord.y / 1000.0);

    vec3 final = bg * trans + col;

    // Soft tonemap so accumulated highlights don't blow out.
    final = final / (final + vec3(0.85));

    gl_FragColor = vec4(final, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTex: { value: texture },
    uTime: { value: 0 },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uViewSize: { value: new THREE.Vector2(0.7, 0.7) },
    uBoxMin: { value: new THREE.Vector3() },
    uBoxMax: { value: new THREE.Vector3() },
    uLightDir: { value: new THREE.Vector3(0.4, 0.6, 0.7).normalize() },
  },
  vertexShader,
  fragmentShader,
  // Render the back faces of the box so the ray always enters at
  // the far side — that lets us cleanly intersect the AABB even
  // when the camera is inside the slab.
  side: THREE.BackSide,
  transparent: false,
  depthWrite: false,
});

const mesh = new THREE.Mesh(boxGeo, material);
scene.add(mesh);

// Size the slab so its XY footprint always overflows the camera
// frustum at z=0, then sync the matching uBoxMin/uBoxMax uniforms.
function sizeSlab() {
  const vFov = (camera.fov * Math.PI) / 180;
  // World height at z=0 (one unit in front of the camera by the
  // camera distance):
  const visH = 2 * camera.position.z * Math.tan(vFov / 2);
  const visW = visH * camera.aspect;
  // Add a 1.5× margin so we never see the slab edge through a
  // wide-aspect window.
  SLAB_W = visW * 1.5;
  SLAB_H = visH * 1.5;
  mesh.scale.set(SLAB_W, SLAB_H, 1);
  material.uniforms.uBoxMin.value.set(-SLAB_W / 2, -SLAB_H / 2, -SLAB_D / 2);
  material.uniforms.uBoxMax.value.set(SLAB_W / 2, SLAB_H / 2, SLAB_D / 2);
  hitPlane.scale.set(SLAB_W, SLAB_H, 1);
}

// ------------------------------------------------------------------
// 4. Camera centring — the caret is *always* dead-centre in the
//    viewport. There's no lerp toward it and no clamp against the
//    atlas edges; the cursor sits in the middle, the document
//    glides past it. Tunnel vision: you see only what you're
//    looking at right now.
// ------------------------------------------------------------------
const viewSize = new THREE.Vector2(0.7, 0.7);
const camOrigin = new THREE.Vector2(0.5, 0.5);

function updateViewSize() {
  // Wide enough to read a full line of body text — but not the
  // whole page, so the camera-follow still has somewhere to glide.
  const aspect = window.innerWidth / window.innerHeight;
  const baseH = 0.72;
  viewSize.set(baseH * aspect, baseH);
  material.uniforms.uViewSize.value.copy(viewSize);
}

function targetOrigin() {
  return new THREE.Vector2(cursorAtlasPx / TEX, 1 - cursorAtlasPy / TEX);
}

// ------------------------------------------------------------------
// 5. Click / drag → caret. Raycast the box's *front face* plane
//    (z = SLAB_D/2 in box-local) to recover an atlas position.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
// A flat invisible plane at the front of the slab for hit-testing —
// the box itself is back-side only, so a normal raycast misses.
const hitPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1, 1, 1),
  new THREE.MeshBasicMaterial({ visible: false }),
);
hitPlane.position.set(0, 0, SLAB_D / 2);
scene.add(hitPlane);

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(hitPlane);
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
  sizeSlab();
}
window.addEventListener("resize", resize);
resize();

function initCamera() {
  renderTexture();
  camOrigin.copy(targetOrigin());
  material.uniforms.uOrigin.value.copy(camOrigin);
}

const clock = new THREE.Clock();
function tick() {
  material.uniforms.uTime.value = clock.getElapsedTime();
  renderTexture();
  texture.needsUpdate = true;

  camOrigin.copy(targetOrigin());
  material.uniforms.uOrigin.value.copy(camOrigin);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Archivo Black"`).then(() => {
  initCamera();
  tick();
});
