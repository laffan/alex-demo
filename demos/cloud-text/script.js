import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette — bright glyphs against a near-black sky.
// ------------------------------------------------------------------
const BG_HEX = "#05060a";
const TEXT_HEX = "#ffffff";
const SELECTION_HEX = "#6a86ff";
const CURSOR_HEX = "#aeefff";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror 6 editor (owns input, selection, history)
// ------------------------------------------------------------------
const initialDoc = `CLOUDS

Write here as if it were smoke.
The glyphs are a density field;
the field is sampled by a slab
of noise raymarched per pixel.

Try a # heading or a > quote.`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Texture canvas — the editor rasterised as a *density* map. The
//    fragment shader treats the red channel as how much smoke sits at
//    z=0 at each UV; everything else (light, depth, billow) is
//    procedural in the shader.
// ------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

const FONT_SIZE = 140;
const LINE_HEIGHT = 168;
const PADDING = 220;
const FONT_FAMILY = '"Archivo Black", "Inter", sans-serif';

let cursorBlink = true;
setInterval(() => {
  cursorBlink = !cursorBlink;
}, 530);

let scrollTopRow = 0;
let visualRows = [];

function lineStyle(text) {
  const h = /^(#{1,6})\s+/.exec(text);
  if (h) {
    const level = h[1].length;
    return {
      weight: "900",
      size: Math.max(FONT_SIZE - (level - 1) * 14, FONT_SIZE - 40),
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
      tctx.fillStyle = TEXT_HEX;
      tctx.fillRect(PADDING - 36, y + 12, 10, s.size - 24);
    }

    // Selection: drawn in a distinct hue so the shader can tell glyphs
    // and selection apart from the red channel alone. We use a bluer
    // tone for selection — the fragment shader looks at .b minus .r to
    // recover a selection mask.
    if (hasRange && selTo > row.startDocPos && selFrom <= row.endDocPos) {
      const startCol = Math.max(0, selFrom - row.startDocPos);
      const endCol = Math.min(row.text.length, selTo - row.startDocPos);
      const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
      const extendsPastRow = selTo > row.endDocPos;
      const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 18);
      tctx.fillStyle = SELECTION_HEX;
      tctx.fillRect(x1, y, xEnd - x1, s.size + 8);
    }

    tctx.fillStyle = TEXT_HEX;
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
      tctx.fillStyle = CURSOR_HEX;
      tctx.fillRect(PADDING + wBefore, y + 8, blockWidth, s.size - 8);
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js: a single full-screen plane, raymarched as a thin
//    volumetric slab. The texture is the slab's density at z=0; 3D
//    fbm noise stretches that density out along z and warps the UV
//    lookup so the glyphs read as billowing smoke rather than a flat
//    sticker on glass.
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

// One quad. The shader does all the work.
const geometry = new THREE.PlaneGeometry(3.4, 3.4, 1, 1);

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Volumetric pass. For each fragment we step through a small range
// of z (the "slab"), sample 3D fbm noise (animated), and sample the
// text atlas with a noise-displaced UV. The text serves as 2D
// density centred on z=0 and falling off with a gaussian window.
// Emission accumulates in front-to-back order with Beer-Lambert
// transmittance, so the front of a cloud occludes its back — exactly
// what gives glyphs their "soft volume" look.
const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform float uTime;
  uniform vec2 uRes;
  varying vec2 vUv;

  float hash13(vec3 p) {
    p  = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
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
      f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p *= 2.07;
      a *= 0.5;
    }
    return v;
  }

  // Background — a faint, slowly drifting sky so the canvas is never
  // dead flat black behind the clouds.
  vec3 sky(vec2 uv) {
    float g = smoothstep(0.0, 1.4, 1.0 - length(uv - vec2(0.5, 0.6)));
    vec3 deep = vec3(0.018, 0.022, 0.032);
    vec3 lift = vec3(0.06, 0.08, 0.13);
    float n = fbm(vec3(uv * 3.0, uTime * 0.04)) * 0.4;
    return mix(deep, lift, g * 0.65) + vec3(n) * 0.04;
  }

  void main() {
    vec2 uv = vUv;

    // Camera-style ray for parallax-flavoured depth: each slab slice
    // sits at a slightly different uv, so glyphs at the back of the
    // slab appear shifted relative to the front. Cheap, sells volume.
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 ro = vec3(0.0, 0.0, 1.0);
    vec3 rd = normalize(vec3(ndc * 0.45, -1.0));

    const int STEPS = 32;
    float zNear = -0.55;
    float zFar  =  0.55;
    float dz = (zFar - zNear) / float(STEPS);

    vec3 emit = vec3(0.0);
    float trans = 1.0;

    // Light direction in slab space — gives the clouds a soft self-
    // shadow along z.
    vec3 lightDir = normalize(vec3(0.35, 0.45, 1.0));

    for (int s = 0; s < STEPS; s++) {
      float t = (float(s) + 0.5) / float(STEPS);
      float z = mix(zNear, zFar, t);

      // ray uv at this slab depth
      vec3 p = ro + rd * (1.0 - t) * 1.4;
      vec2 ruv = p.xy * 0.5 + 0.5;

      // 3D fbm domain for both warp and density modulation.
      vec3 np = vec3(ruv * 4.2, z * 2.6 + uTime * 0.18);
      float n  = fbm(np);
      float n2 = fbm(np * 1.7 + 11.3);

      // Noise-warped lookup into the text atlas. The warp scale grows
      // with |z| so the front and back of each glyph fray outward,
      // exactly like a slice through a column of smoke.
      vec2 wuv = ruv + (vec2(n, n2) - 0.5) * (0.045 + 0.085 * abs(z));
      vec4 texel = texture2D(uTex, wuv);

      // Channel-split: red drives the glyph density, the bluer pixels
      // we painted for selection drive a separately-coloured density
      // so highlighted runs glow in a different hue.
      float glyph = texel.r;
      float seln  = clamp(texel.b - texel.r * 0.6, 0.0, 1.0);

      // Gaussian window in z so density peaks at the slab centre.
      float window = exp(-z * z * 11.0);
      float dens = (glyph * 0.85 + seln * 0.6) * window * (0.45 + 0.85 * n);

      // Soft self-shadow: sample density once along the light dir, a
      // single tap is enough to get the "thicker = darker behind"
      // feel without paying for a full secondary march.
      vec3 lp = vec3(wuv, z) + lightDir * 0.06;
      float shadow = fbm(vec3(lp.xy * 4.2, lp.z * 2.6 + uTime * 0.18));
      float lit = clamp(1.0 - dens * 0.4 * (1.0 - shadow), 0.25, 1.0);

      // Two-tone emission: warm core, cool fringe. Selection is bluer
      // still and pushed brighter.
      vec3 textCol = mix(
        vec3(0.92, 0.85, 0.72),
        vec3(1.05, 1.02, 0.94),
        smoothstep(0.0, 1.0, dens * 2.5));
      vec3 selCol = vec3(0.55, 0.72, 1.25);
      vec3 sliceEmit = mix(textCol, selCol, clamp(seln * 1.4, 0.0, 1.0));
      sliceEmit *= lit;

      emit  += trans * sliceEmit * dens * dz * 3.6;
      trans *= exp(-dens * dz * 5.5);

      if (trans < 0.01) break;
    }

    vec3 bg = sky(uv);
    vec3 col = bg * trans + emit;

    // gentle vignette
    float vig = smoothstep(1.15, 0.2, length(uv - 0.5));
    col *= 0.78 + 0.22 * vig;

    // tone map + tiny grain so the dark areas have life
    col = col / (col + vec3(0.85));
    float grain = (hash13(vec3(gl_FragCoord.xy, uTime)) - 0.5) * 0.025;
    col += grain;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTex: { value: texture },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2() },
  },
  vertexShader,
  fragmentShader,
});

const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);

// ------------------------------------------------------------------
// 4. Click + drag to move the caret / select text. Same approach as
//    the undulating-surface demo: raycast the (still-flat) plane, get
//    a UV, walk the visualRows table to recover a doc position.
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
// 5. Resize + animation loop. Defer kickoff until Archivo Black has
//    actually loaded, otherwise the first few frames render in the
//    fallback sans and the glyphs come out thinner than the shader
//    expects.
// ------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  material.uniforms.uRes.value.set(w, h);
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

document.fonts.load(`${FONT_SIZE}px "Archivo Black"`).then(tick);
