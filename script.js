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

const geometry = new THREE.PlaneGeometry(3.2, 3.2, 192, 192);

// Domain-warped vertex displacement, in the spirit of iterative
// sin/cos warping (Inigo Quilez–style flow). Each pass feeds its output
// back into the next, so the surface ripples in long, organic curves
// rather than a single sine wave.
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
