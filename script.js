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

// Auto-focus, and refocus when the user clicks the 3D surface.
view.focus();
document.getElementById("stage").addEventListener("pointerdown", () => {
  view.focus();
});

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
  const head = view.state.selection.main.head;
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

const geometry = new THREE.PlaneGeometry(3.2, 3.2, 144, 144);

// Vertex displacement using Inigo Quilez's "Base warp fBM" shader
// (Shadertoy 3sfczf), ported almost verbatim. sin(x)*sin(y) acts as a
// cheap noise primitive; fbm4 / fbm6 stack rotated octaves; func() does
// two passes of domain warping (q → o → n) before a final fBM, then a
// non-linear sharpen via mix(f, f^3 * 3.5, f * |n.x|). We sample this
// per-vertex and push the plane's z by the result.
const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vWarp;

  const mat2 m = mat2(0.80, 0.60, -0.60, 0.80);

  float noise(vec2 p) {
    return sin(p.x) * sin(p.y);
  }

  float fbm4(vec2 p) {
    float f = 0.0;
    f += 0.5000 * noise(p); p = m * p * 2.02;
    f += 0.2500 * noise(p); p = m * p * 2.02;
    f += 0.1250 * noise(p); p = m * p * 2.02;
    f += 0.0625 * noise(p);
    return f / 0.9375;
  }

  float fbm6(vec2 p) {
    float f = 0.0;
    f += 0.500 * (0.5 + 0.5 * noise(p)); p = m * p * 2.02;
    f += 0.500 * (0.5 + 0.5 * noise(p)); p = m * p * 2.02;
    f += 0.500 * (0.5 + 0.5 * noise(p)); p = m * p * 2.02;
    f += 0.250 * (0.5 + 0.5 * noise(p));
    return f / 0.96875;
  }

  vec2 fbm4_2(vec2 p) {
    return vec2(fbm4(p), fbm4(p + vec2(7.8)));
  }

  vec2 fbm6_2(vec2 p) {
    return vec2(fbm6(p + vec2(16.8)), fbm6(p + vec2(11.5)));
  }

  float baseWarp(vec2 q, float t) {
    q += 0.03 * sin(vec2(0.27, 0.23) * t + length(q) * vec2(4.1, 4.3));
    vec2 o = fbm4_2(0.9 * q);
    o += 0.04 * sin(vec2(0.12, 0.14) * t + length(o));
    vec2 n = fbm6_2(3.0 * o);
    float f = 0.5 + 0.5 * fbm4(1.8 * q + 6.0 * n);
    return mix(f, f * f * f * 3.5, f * abs(n.x));
  }

  void main() {
    vUv = uv;
    vec3 pos = position;
    float f = baseWarp(pos.xy * 0.9, uTime * 0.35);
    float h = (f - 0.5) * 0.35;
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
// 4. Resize + animation loop
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
