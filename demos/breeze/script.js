import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";

// ------------------------------------------------------------------
// 0. Palette.
// ------------------------------------------------------------------
const BG_HEX = "#2c3038";
const INK_HEX = "#1c2030";

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor. Each typed character maps to a small
//    cloth-banner Mesh in the scene; the doc listener rebuilds the
//    banner layout when the document changes.
// ------------------------------------------------------------------
const initialDoc = `the wind writes through the words`;

let docDirty = true;

const view = new EditorView({
  doc: initialDoc,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) docDirty = true;
    }),
  ],
  parent: document.getElementById("editor-host"),
});
view.focus();

// ------------------------------------------------------------------
// 2. Glyph atlas. One canvas with every printable ASCII glyph drawn
//    in a fixed-size cell. Each per-character mesh later samples a
//    sub-rect of this atlas via a (uGlyphUv, uGlyphSize) uniform.
// ------------------------------------------------------------------
const GLYPH_COLS = 16;
const GLYPH_ROWS = 8;
const GLYPH_CELL = 256;
const GLYPH_ATLAS_W = GLYPH_COLS * GLYPH_CELL;
const GLYPH_ATLAS_H = GLYPH_ROWS * GLYPH_CELL;

const glyphCanvas = document.createElement("canvas");
glyphCanvas.width = GLYPH_ATLAS_W;
glyphCanvas.height = GLYPH_ATLAS_H;
const gctx = glyphCanvas.getContext("2d");

function renderGlyphAtlas() {
  gctx.fillStyle = "#000";
  gctx.fillRect(0, 0, GLYPH_ATLAS_W, GLYPH_ATLAS_H);
  gctx.fillStyle = "#fff";
  gctx.font = `700 200px "Cormorant Garamond", Georgia, serif`;
  gctx.textAlign = "center";
  gctx.textBaseline = "middle";
  for (let code = 32; code < 32 + GLYPH_COLS * GLYPH_ROWS; code++) {
    const idx = code - 32;
    const col = idx % GLYPH_COLS;
    const row = Math.floor(idx / GLYPH_COLS);
    const x = col * GLYPH_CELL + GLYPH_CELL / 2;
    const y = row * GLYPH_CELL + GLYPH_CELL / 2;
    gctx.fillText(String.fromCharCode(code), x, y);
  }
}
renderGlyphAtlas();

const glyphTex = new THREE.CanvasTexture(glyphCanvas);
glyphTex.minFilter = THREE.LinearMipMapLinearFilter;
glyphTex.magFilter = THREE.LinearFilter;
glyphTex.anisotropy = 4;
// The default canvas-texture flipY = true means canvas Y=0 maps to UV
// V=1. Our glyph-uv lookup compensates with `1 - (row+1)/ROWS`.

function glyphUvFor(ch) {
  const code = ch.charCodeAt(0);
  if (code < 32 || code >= 32 + GLYPH_COLS * GLYPH_ROWS) return null;
  const idx = code - 32;
  const col = idx % GLYPH_COLS;
  const row = Math.floor(idx / GLYPH_COLS);
  return {
    u: col / GLYPH_COLS,
    // Canvas y=0 is the top, but UV v=0 is the bottom (after flipY).
    // Compute the UV of the bottom-left of this glyph's cell.
    v: 1 - (row + 1) / GLYPH_ROWS,
    du: 1 / GLYPH_COLS,
    dv: 1 / GLYPH_ROWS,
  };
}

// ------------------------------------------------------------------
// 3. three.js setup.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_HEX);

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 5.5);
camera.lookAt(0, 0, 0);

// Linen texture — shared across every banner. The fragment shader
// samples this for the cloth colour and the glyph atlas for the ink
// silhouette, then blends between them per pixel.
const linenTex = new THREE.TextureLoader().load("./pattern.jpg", (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
});
linenTex.wrapS = linenTex.wrapT = THREE.RepeatWrapping;
linenTex.colorSpace = THREE.SRGBColorSpace;

// ------------------------------------------------------------------
// 4. Per-character cloth shader. The vertex shader simulates a wind
//    sway with the top edge of each banner pinned (uv.y = 1) and the
//    bottom edge swinging free. Two cosines drive a lateral sway and
//    a forward/back curl; the curl folds in extra at the bottom
//    corners so the cloth reads as draped, not just translated. Each
//    banner has its own uPhase so they don't oscillate in unison.
// ------------------------------------------------------------------
const CHAR_W = 0.40;
const CHAR_H = 0.58;
// PlaneGeometry is centred on the origin; we move it up by half its
// height so the *top edge* is at local y=0 (the pinned point).
const charGeo = new THREE.PlaneGeometry(CHAR_W, CHAR_H, 6, 10);
charGeo.translate(0, -CHAR_H / 2, 0);

const charVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  uniform float uAnchorX;
  varying vec2 vUv;
  varying float vSway;

  void main() {
    vec3 pos = position;
    vUv = uv;

    // free=0 at the anchored top, free=1 at the loose bottom.
    float free = 1.0 - uv.y;
    float free2 = free * free;
    float t = uTime * 1.05 + uPhase;

    // Big-picture lateral and forward sway — the same gust drives both
    // axes with slightly different periods so the bottom traces a
    // soft lissajous instead of a flat side-to-side line.
    float gust = sin(t * 0.55 + uAnchorX * 0.25);
    pos.x += (0.085 * gust + 0.025 * sin(t * 1.6)) * free;
    pos.z += (0.16 * sin(t * 0.85 + 0.6) +
              0.05 * sin(t * 2.3 + uAnchorX)) * free;

    // Subtle dip: the cloth never floats above its anchor, so the
    // sin is wrapped through an absolute value.
    pos.y -= abs(sin(t * 0.65)) * 0.04 * free2;

    // Vertical fold ripple — a travelling wave along uv.y that bends
    // the cloth out of plane near the corners. Amplitude grows toward
    // the bottom corners (free2 * |2u - 1|).
    float corner = abs(uv.x * 2.0 - 1.0);
    pos.z += sin(uv.y * 4.5 - t * 1.4 + uPhase * 0.7)
           * 0.045 * free2 * corner;
    // Sideways curl — a lateral pinch near the corners.
    pos.x += sin(uv.y * 5.2 + t * 1.1)
           * 0.018 * free2 * (uv.x - 0.5) * 2.0;

    vSway = gust;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const charFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uLinenTex;
  uniform sampler2D uGlyphAtlas;
  uniform vec2 uGlyphUv;
  uniform vec2 uGlyphSize;
  uniform vec3 uInkColor;
  uniform float uLinenScale;
  uniform float uAnchorX;
  uniform float uAnchorY;
  varying vec2 vUv;
  varying float vSway;

  void main() {
    // Linen sampled in *banner-space*, offset by the banner's anchor
    // so neighbouring banners share a continuous weave rather than
    // each repeating from zero. uLinenScale controls visible thread
    // density.
    vec2 linenUv = (vUv + vec2(uAnchorX, uAnchorY)) * uLinenScale;
    vec3 linen = texture2D(uLinenTex, linenUv).rgb;

    // Glyph atlas — vUv directly indexes into the glyph's cell, with
    // a tiny inset so the bilinear filter doesn't bleed in colour
    // from neighbouring cells along the cell boundary.
    vec2 inset = uGlyphSize * 0.02;
    vec2 glyphUv = uGlyphUv + inset + vUv * (uGlyphSize - 2.0 * inset);
    float ink = smoothstep(0.25, 0.65, texture2D(uGlyphAtlas, glyphUv).r);

    // Fake side-lighting from vSway — when the cloth is mid-gust the
    // shaded side darkens slightly. Sells the 3D-ness of the warp.
    float shade = 0.92 + 0.10 * vSway * (vUv.x - 0.5);

    vec3 col = mix(linen, uInkColor, ink) * shade;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeCharMaterial(glyph, anchorX, anchorY, phase) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPhase: { value: phase },
      uAnchorX: { value: anchorX },
      uAnchorY: { value: anchorY },
      uLinenTex: { value: linenTex },
      uGlyphAtlas: { value: glyphTex },
      uGlyphUv: { value: new THREE.Vector2(glyph.u, glyph.v) },
      uGlyphSize: { value: new THREE.Vector2(glyph.du, glyph.dv) },
      uInkColor: { value: new THREE.Color(INK_HEX) },
      uLinenScale: { value: 1.4 },
    },
    vertexShader: charVertex,
    fragmentShader: charFragment,
  });
}

// ------------------------------------------------------------------
// 5. Layout. Characters are laid out in fixed-pitch columns and rows.
//    A column counter wraps on newline or when the column overflows
//    the visible width. Layout positions are tracked per-character
//    so the pointer-hit-test can map a click back to a doc index.
// ------------------------------------------------------------------
const CHAR_ADV = 0.34;   // horizontal pitch between banners
const LINE_PITCH = 0.78; // vertical pitch between rows
const COLS_PER_LINE = 16;
const START_X = -((COLS_PER_LINE - 1) * CHAR_ADV) / 2;
const START_Y = 1.5;

let charEntries = []; // { docPos, col, row, mesh, material, char }

function disposeEntry(entry) {
  scene.remove(entry.mesh);
  entry.material.dispose();
}

function rebuildLayout() {
  for (const e of charEntries) disposeEntry(e);
  charEntries = [];

  const text = view.state.doc.toString();
  let col = 0;
  let row = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      col = 0;
      row++;
      continue;
    }
    if (col >= COLS_PER_LINE) {
      col = 0;
      row++;
    }

    const x = START_X + col * CHAR_ADV;
    const y = START_Y - row * LINE_PITCH;
    // Position-derived phase: a stable hash of (col, row) so each
    // banner has its own oscillation pattern, but the same physical
    // slot animates the same way frame to frame even as letters
    // shift in and out of it as the user edits.
    const phase = (col * 0.83 + row * 1.71) % 6.2831853;

    const glyph = glyphUvFor(ch);
    if (glyph) {
      const mat = makeCharMaterial(glyph, x, y, phase);
      const mesh = new THREE.Mesh(charGeo, mat);
      mesh.position.set(x, y, 0);
      scene.add(mesh);
      charEntries.push({
        docPos: i,
        col,
        row,
        mesh,
        material: mat,
        char: ch,
      });
    } else {
      // Unprintable but still a layout slot (a space, mostly).
      charEntries.push({ docPos: i, col, row, mesh: null, material: null, char: ch });
    }
    col++;
  }
}

// ------------------------------------------------------------------
// 6. Click / drag → caret. Hit the (flat, undeformed) layout plane,
//    convert to (col, row), then walk the same layout loop the
//    visible meshes use to find the doc position underneath.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hitPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100, 1, 1),
  new THREE.MeshBasicMaterial({ visible: false }),
);
scene.add(hitPlane);

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(hitPlane);
  if (!hits.length) return null;
  const p = hits[0].point;

  // Target column & row in layout coordinates.
  const tCol = Math.round((p.x - START_X) / CHAR_ADV);
  const tRow = Math.round((START_Y - p.y) / LINE_PITCH);

  // Walk the layout and find the doc position whose (col, row)
  // matches, falling back to the end of the closest visible row.
  let best = view.state.doc.length;
  let bestDist = Infinity;
  for (const e of charEntries) {
    const dx = e.col - tCol;
    const dy = e.row - tRow;
    const d = dx * dx * 0.5 + dy * dy * 1.5;
    if (d < bestDist) {
      bestDist = d;
      best = e.docPos;
    }
  }
  return best;
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
// 7. Resize + animation loop.
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
  if (docDirty) {
    rebuildLayout();
    docDirty = false;
  }
  const t = clock.getElapsedTime();
  for (const e of charEntries) {
    if (e.material) e.material.uniforms.uTime.value = t;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`700 200px "Cormorant Garamond"`).then(() => {
  // Re-render the glyph atlas now that the web font is actually
  // available — the very first paint a few lines up used the system
  // fallback.
  renderGlyphAtlas();
  glyphTex.needsUpdate = true;
  rebuildLayout();
  docDirty = false;
  tick();
});
