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
// 1. Hidden CodeMirror 6 editor.
// ------------------------------------------------------------------
const initialDoc = `CLOUDS

write here as if it
were smoke

# a heading is louder

> a quote is bracketed`;

const view = new EditorView({
  doc: initialDoc,
  extensions: [basicSetup, markdown()],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Texture canvas — same role as in demo #01: a 2D rasterisation
//    of the editor that the GPU samples. The font is now much bigger
//    so individual glyphs read at the camera's close zoom; the atlas
//    grows to match. Selection and cursor still get their own paint
//    colours so the shader can recover them from RGB alone.
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
// Pixel coords of the caret in the atlas; the camera lerps toward
// these every frame so the cursor stays roughly in the middle of
// the screen as you type.
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

  // We still keep a "scroll" concept so a long document can't paint
  // outside the atlas, but with the camera following the caret the
  // visible window is small and centred — we just need enough rows
  // above/below cursor to stay in atlas bounds while panning.
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
      tctx.fillRect(PADDING - 40, y + 12, 14, s.size - 24);
    }

    if (hasRange && selTo > row.startDocPos && selFrom <= row.endDocPos) {
      const startCol = Math.max(0, selFrom - row.startDocPos);
      const endCol = Math.min(row.text.length, selTo - row.startDocPos);
      const x1 = PADDING + tctx.measureText(row.text.slice(0, startCol)).width;
      const x2 = PADDING + tctx.measureText(row.text.slice(0, endCol)).width;
      const extendsPastRow = selTo > row.endDocPos;
      const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 30);
      tctx.fillStyle = SELECTION_HEX;
      tctx.fillRect(x1, y, xEnd - x1, s.size + 20);
    }

    tctx.fillStyle = TEXT_HEX;
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

      // Always record the caret atlas position — the JS-side camera
      // pan reads it even when the visible cursor block is blinked
      // off, so the camera doesn't pulse with the blink.
      cursorAtlasPx = PADDING + wBefore + blockWidth * 0.5;
      cursorAtlasPy = y + s.size * 0.5;

      if (cursorBlink) {
        tctx.fillStyle = CURSOR_HEX;
        tctx.fillRect(PADDING + wBefore, y + 20, blockWidth, s.size - 20);
      }
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js: a single full-screen quad. The fragment shader does
//    a *cheap* volumetric pass — far fewer steps than the original,
//    no per-step shadow tap, and a 5-tap "is there text near here?"
//    pre-check that lets it skip the march entirely on empty sky.
//    For a screen of mostly-empty background that pre-check is what
//    keeps the framerate up.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_HEX);

// Orthographic-ish camera: a single quad covers the screen, all the
// "depth" is conjured in the fragment shader.
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);

const texture = new THREE.CanvasTexture(texCanvas);
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Volumetric pass, lean version. The march itself is only 8 steps
// — the visible "fluff" comes from two things:
//
//   1) A per-pixel stochastic jitter on the march start. Without
//      this, an 8-step march reads as 8 concentric ridges around
//      each glyph (visible banding). With it, neighbouring pixels
//      sample slightly different z values along the slab, and the
//      banding turns into film-grain-like softness that integrates
//      to a soft volume over a few pixels of TAA-less screen-space
//      blur.
//
//   2) Coarse, low-frequency 2D fbm — one octave for shape, one
//      higher-frequency octave at half amplitude for grain. With z
//      baked into the noise translation, every slice has its own
//      cloud pattern but neighbouring slices stay correlated.
//
// The 5-tap density probe survives because it's still the biggest
// win: on a typical screen the empty-sky pixels (which is most of
// the screen now that the camera is zoomed out) skip the march
// entirely.
const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform float uTime;
  uniform vec2 uOrigin;     // atlas UV the camera is centred on
  uniform vec2 uViewSize;   // fraction of atlas the screen shows
  uniform vec2 uRes;
  varying vec2 vUv;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // 2-octave fbm.
  float fbm2(vec2 p) {
    return vnoise(p) * 0.65 + vnoise(p * 2.0 + 11.3) * 0.35;
  }

  vec3 sky(vec2 sUv) {
    float g = smoothstep(0.0, 1.4, 1.0 - length(sUv - vec2(0.5, 0.55)));
    vec3 deep = vec3(0.018, 0.022, 0.032);
    vec3 lift = vec3(0.06, 0.08, 0.13);
    return mix(deep, lift, g * 0.65);
  }

  float densityProbe(vec2 atlasUv) {
    float r = 0.0;
    vec4 t0 = texture2D(uTex, atlasUv);
    vec4 t1 = texture2D(uTex, atlasUv + vec2( 0.060, 0.0));
    vec4 t2 = texture2D(uTex, atlasUv + vec2(-0.060, 0.0));
    vec4 t3 = texture2D(uTex, atlasUv + vec2(0.0,  0.060));
    vec4 t4 = texture2D(uTex, atlasUv + vec2(0.0, -0.060));
    r = max(r, max(t0.r, t0.b));
    r = max(r, max(t1.r, t1.b));
    r = max(r, max(t2.r, t2.b));
    r = max(r, max(t3.r, t3.b));
    r = max(r, max(t4.r, t4.b));
    return r;
  }

  void main() {
    vec2 atlasUv = uOrigin + (vUv - 0.5) * uViewSize;

    float probe = densityProbe(atlasUv);
    if (probe < 0.03) {
      vec3 col = sky(vUv);
      float vig = smoothstep(1.15, 0.2, length(vUv - 0.5));
      col *= 0.78 + 0.22 * vig;
      gl_FragColor = vec4(col, 1.0);
      return;
    }

    // Sample the *unwarped* atlas at this fragment too. The march
    // below also samples warped UVs; we anchor against the unwarped
    // value so the warp can only ADD density, never gnaw the glyph
    // dark from inside. Without this anchor, the holes in 'o', 'e',
    // 'B' read as black cutouts: their fragments pass the probe
    // (because the probe radius is wider than glyph stems), but
    // inside the march the warp consistently lands off the glyph
    // and accumulates zero emission, leaving the counter-form
    // looking darker than its surrounding letterform.
    vec4 centerTexel = texture2D(uTex, atlasUv);
    float glyphCenter = centerTexel.r;
    float selnCenter = clamp(centerTexel.b - centerTexel.r * 0.6, 0.0, 1.0);

    const int STEPS = 8;
    float zNear = -0.50;
    float zFar  =  0.50;
    float dz = (zFar - zNear) / float(STEPS);

    // Spatial-only jitter on the march phase — temporal jitter looks
    // like film grain but it strobes without TAA, so we only spread
    // the steps across neighbouring pixels.
    float jitter = hash12(gl_FragCoord.xy);

    vec3 emit = vec3(0.0);
    float trans = 1.0;

    for (int s = 0; s < STEPS; s++) {
      float t = (float(s) + jitter) / float(STEPS);
      float z = mix(zNear, zFar, t);

      vec2 np = atlasUv * 3.0 + vec2(z * 1.4, uTime * 0.08);
      float n  = fbm2(np);
      float n2 = fbm2(np * 1.7 + 19.7);

      vec2 wuv = atlasUv + (vec2(n, n2) - 0.5) * (0.018 + 0.070 * abs(z));
      vec4 texel = texture2D(uTex, wuv);

      // max() with the center sample means the warp can puff density
      // outward but can't dim what's already on the glyph.
      float glyph = max(glyphCenter, texel.r);
      float seln  = max(selnCenter, clamp(texel.b - texel.r * 0.6, 0.0, 1.0));

      float window = exp(-z * z * 7.0);
      // Noise floor raised from 0.45 to 0.80 so the multiplicative
      // noise can no longer take density below 80% of its glyph
      // value. The 0.30 swing still gives clouds visible texture
      // without ever flickering through to the sky.
      float dens = (glyph * 1.0 + seln * 0.7) * window * (0.80 + 0.30 * n);

      vec3 textCol = vec3(0.95, 0.92, 0.82);
      vec3 selCol  = vec3(0.55, 0.72, 1.25);
      vec3 sliceEmit = mix(textCol, selCol, clamp(seln * 1.4, 0.0, 1.0));
      sliceEmit *= mix(0.55, 1.05, t);

      emit  += trans * sliceEmit * dens * dz * 4.4;
      trans *= exp(-dens * dz * 5.2);

      if (trans < 0.02) break;
    }

    vec3 bg = sky(vUv);
    vec3 col = bg * trans + emit;

    float vig = smoothstep(1.15, 0.2, length(vUv - 0.5));
    col *= 0.78 + 0.22 * vig;

    col = col / (col + vec3(0.85));

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTex: { value: texture },
    uTime: { value: 0 },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uViewSize: { value: new THREE.Vector2(0.4, 0.4) },
  },
  vertexShader,
  fragmentShader,
});

const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);

// ------------------------------------------------------------------
// 4. Camera follow: lerp the atlas origin toward the cursor each
//    frame, and clamp so the visible window stays inside the atlas.
// ------------------------------------------------------------------
let viewSize = new THREE.Vector2(0.4, 0.4);
let camOrigin = new THREE.Vector2(0.5, 0.5);

function updateViewSize() {
  // Show roughly the same atlas height regardless of aspect; widen
  // the horizontal view on landscape monitors. baseH=0.78 means the
  // screen height covers ~78% of the atlas — most of the page is
  // visible at all times, the camera just glides a little to follow
  // the caret near the edges.
  const aspect = window.innerWidth / window.innerHeight;
  const baseH = 0.78;
  viewSize.set(Math.min(0.96, baseH * aspect), Math.min(0.96, baseH));
  material.uniforms.uViewSize.value.copy(viewSize);
}

function clampOrigin(o) {
  const halfW = viewSize.x * 0.5;
  const halfH = viewSize.y * 0.5;
  o.x = Math.min(Math.max(o.x, halfW), 1 - halfW);
  o.y = Math.min(Math.max(o.y, halfH), 1 - halfH);
}

function targetOrigin() {
  // Atlas pixels y axis runs top-to-bottom; UV y runs bottom-to-top.
  return new THREE.Vector2(cursorAtlasPx / TEX, 1 - cursorAtlasPy / TEX);
}

// ------------------------------------------------------------------
// 5. Click + drag to move the caret / select text. The hit test has
//    to undo the same pan+zoom the shader applied so a click on a
//    visible glyph maps to the correct atlas pixel.
// ------------------------------------------------------------------
function docPosFromPointer(event) {
  const sx = event.clientX / window.innerWidth;
  const sy = 1 - event.clientY / window.innerHeight;
  const atlasU = camOrigin.x + (sx - 0.5) * viewSize.x;
  const atlasV = camOrigin.y + (sy - 0.5) * viewSize.y;
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
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  updateViewSize();
}
window.addEventListener("resize", resize);
resize();

// Snap the camera to the initial cursor position so we don't pan from
// (0.5, 0.5) on first frame.
function initCamera() {
  renderTexture();
  const t = targetOrigin();
  clampOrigin(t);
  camOrigin.copy(t);
  material.uniforms.uOrigin.value.copy(camOrigin);
}

const clock = new THREE.Clock();
function tick() {
  material.uniforms.uTime.value = clock.getElapsedTime();
  renderTexture();
  texture.needsUpdate = true;

  const t = targetOrigin();
  clampOrigin(t);
  // Lerp factor — high enough to keep up with fast typing, low
  // enough that arrow-key sweeps glide rather than jump.
  const k = 0.12;
  camOrigin.x += (t.x - camOrigin.x) * k;
  camOrigin.y += (t.y - camOrigin.y) * k;
  material.uniforms.uOrigin.value.copy(camOrigin);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Archivo Black"`).then(() => {
  initCamera();
  tick();
});
