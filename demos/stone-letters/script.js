import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";
import RAPIER from "https://esm.sh/@dimforge/rapier3d-compat@0.13.0";

// ------------------------------------------------------------------
// 0. Palette — almost-white ground, stones in a range of blues.
// ------------------------------------------------------------------
const SKY_HEX = "#fafafa";
const HORIZON_HEX = "#e0e0e0";
const GROUND_HEX = "#f6f6f6";
const GROUND_DEEP_HEX = "#cdcdcd";

// Two anchor blues; per-stone tint randomly slides between them so
// the pile reads as many shades of one colour family rather than a
// single uniform blue.
const ROCK_BASE_HEX = "#1c3354";
const ROCK_HI_HEX = "#8db8e6";
const ROCK_SELECT_HEX = "#d68a2c";

// Wait for the Rapier WASM blob to decode before doing anything else.
// The compat build embeds the WASM as base64 so we don't need a
// separate fetch and a CORS dance.
await RAPIER.init();

// ------------------------------------------------------------------
// 1. Hidden CodeMirror editor. Two things hang off it:
//   - docDirty: rebuild the terrain heightfield when text changes.
//   - selectionDirty: rebuild rock tints when selection range changes.
// ------------------------------------------------------------------
const initialDoc = `If falling hurts;

Why do people fall in love?`;

let docDirty = true;
let selectionDirty = true;

// Typing-activity meter. Each doc change adds a pulse; the meter
// decays exponentially each frame. We use it to drive the rock spawn
// rate so the rain accelerates while you're typing and slows back
// to a trickle when you stop.
let typingActivity = 0;

const view = new EditorView({
  doc: initialDoc,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        docDirty = true;
        // Sum up the size of inserted+deleted text so paste / large
        // edits register as a bigger burst than a single keypress.
        let chars = 0;
        u.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          chars += inserted.length + (toA - fromA);
        });
        typingActivity = Math.min(typingActivity + Math.max(1, chars), 30);
      }
      if (u.selectionSet) selectionDirty = true;
    }),
  ],
  parent: document.getElementById("editor-host"),
});

view.focus();

// ------------------------------------------------------------------
// 2. Text canvas. Same role as the other demos — but here it's a
//    *heightmap source*: white pixels become indents in the ground
//    that rocks fall into and shape themselves around.
// ------------------------------------------------------------------
const TEX = 1024;
const FONT_SIZE = 110;
const LINE_HEIGHT = 140;
const PADDING = 60;
const FONT_FAMILY = '"Bowlby One", sans-serif';

const texCanvas = document.createElement("canvas");
texCanvas.width = TEX;
texCanvas.height = TEX;
const tctx = texCanvas.getContext("2d");

// Downsample target for the heightfield. 128² is enough to read the
// letterforms when rocks settle in, and small enough that the
// Rapier collider rebuild is sub-millisecond.
const HMAP_RES = 192;
const sampleCanvas = document.createElement("canvas");
sampleCanvas.width = HMAP_RES;
sampleCanvas.height = HMAP_RES;
const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });

let visualRows = [];
let scrollTopRow = 0;
let cursorAtlasPx = PADDING;
let cursorAtlasPy = PADDING;

function setFont() {
  tctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  tctx.textBaseline = "alphabetic";
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
    const segs = wrapText(line.text, maxWidth);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const startDocPos = line.from + seg.startCol;
      rows.push({
        text: seg.text,
        startDocPos,
        endDocPos: startDocPos + seg.text.length,
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

function renderTextToCanvas() {
  setFont();
  tctx.fillStyle = "#000";
  tctx.fillRect(0, 0, TEX, TEX);

  visualRows = computeLayout();

  const head = view.state.selection.main.head;
  const cursorRowIdx = findCursorRow(visualRows, head);
  const visibleRowCount = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
  if (cursorRowIdx < scrollTopRow) scrollTopRow = cursorRowIdx;
  if (cursorRowIdx >= scrollTopRow + visibleRowCount)
    scrollTopRow = cursorRowIdx - visibleRowCount + 1;
  if (scrollTopRow < 0) scrollTopRow = 0;

  let y = PADDING;
  for (let r = scrollTopRow; r < visualRows.length; r++) {
    const row = visualRows[r];
    const baseline = y + FONT_SIZE * 0.85;
    tctx.fillStyle = "#fff";
    tctx.fillText(row.text, PADDING, baseline);

    if (r === cursorRowIdx) {
      const localCol = Math.min(
        Math.max(0, head - row.startDocPos),
        row.text.length,
      );
      const wBefore = tctx.measureText(row.text.slice(0, localCol)).width;
      cursorAtlasPx = PADDING + wBefore;
      cursorAtlasPy = y + FONT_SIZE * 0.5;
    }

    y += LINE_HEIGHT;
    if (y > TEX - PADDING) break;
  }
}

// ------------------------------------------------------------------
// 3. three.js: top-down-ish view of a horizontal page. The page is
//    a displaced heightmap; the rocks are an InstancedMesh whose
//    instance matrices are driven by Rapier each frame.
// ------------------------------------------------------------------
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Background colour matches the ground so the page never reads as
// a slab floating against a different-coloured sky on wide windows.
scene.background = new THREE.Color(GROUND_HEX);
scene.fog = new THREE.Fog(GROUND_HEX, 10, 22);

// Soft hemisphere fill, plus a low key sun that casts shadows. The
// raking sun is what makes the rocks read as rocks rather than as
// flat circles — it gives each one a visible shadow on the ground.
scene.add(new THREE.HemisphereLight(0xfff4d4, GROUND_DEEP_HEX, 0.55));
const sun = new THREE.DirectionalLight(0xfff3c8, 1.4);
sun.position.set(4.5, 7.0, 3.2);
sun.castShadow = true;
sun.shadow.camera.left = -6;
sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -6;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 22;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0008;
scene.add(sun);

// Page geometry. The Rapier heightfield is in *world space*; the
// visual mesh has the same dimensions so the two stay in lockstep.
const PAGE_SIZE = 7.0;
const INDENT_DEPTH = 0.30;

// Camera: looking down at an angle so we can see both the rock pile
// and the surface they're forming. CAMERA_DIST pulled back so more
// of the page fits in the frame at once.
const CAMERA_DIST = 8.5;
const CAMERA_TILT = 0.40; // radians forward of straight-down
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  60,
);
function placeCamera() {
  // Camera orbits around (0, 0, 0) at distance CAMERA_DIST, tilted
  // CAMERA_TILT forward (so the bottom of the page is closer).
  const y = Math.cos(CAMERA_TILT) * CAMERA_DIST;
  const z = Math.sin(CAMERA_TILT) * CAMERA_DIST;
  camera.position.set(0, y, z);
  camera.lookAt(0, 0, 0);
}
placeCamera();

// ------------------------------------------------------------------
// 4. Terrain — a high-subdivision plane and a matching Rapier
//    heightfield. Both are rebuilt whenever the document changes.
// ------------------------------------------------------------------

// Plane is in XY local (default). After rotating -π/2 around X, the
// plane lies in the XZ world plane. We want the canvas's (cx, cy)
// to map to world (worldX, worldZ); canvas Y top→bottom becomes
// world Z back→front so the top of the document is at world -Z
// (farther from camera).
const MESH_RES = HMAP_RES; // share vertex resolution with the heightfield
const planeGeo = new THREE.PlaneGeometry(
  PAGE_SIZE,
  PAGE_SIZE,
  MESH_RES - 1,
  MESH_RES - 1,
);
planeGeo.rotateX(-Math.PI / 2);
// PlaneGeometry's default v=0 is at the bottom of the plane; after
// rotateX(-π/2) the bottom-of-plane maps to world +Z. We want canvas
// y=0 (top of doc) to be at world -Z, so we flip v in the geometry.
{
  const uvs = planeGeo.attributes.uv.array;
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1.0 - uvs[i];
  planeGeo.attributes.uv.needsUpdate = true;
}

// We don't bake heights into the plane geometry permanently — the
// shader samples a height texture. That way "rebuilding terrain"
// only updates the texture; no buffer uploads on the JS side.
const heightTexData = new Float32Array(HMAP_RES * HMAP_RES);
const heightTex = new THREE.DataTexture(
  heightTexData,
  HMAP_RES,
  HMAP_RES,
  THREE.RedFormat,
  THREE.FloatType,
);
heightTex.minFilter = THREE.LinearFilter;
heightTex.magFilter = THREE.LinearFilter;
heightTex.wrapS = THREE.ClampToEdgeWrapping;
heightTex.wrapT = THREE.ClampToEdgeWrapping;

// We also pass a small selection-tint texture so the shader can
// brush in a warm wash where the user has a selection range.
const selectionTexData = new Uint8Array(HMAP_RES * HMAP_RES);
const selectionTex = new THREE.DataTexture(
  selectionTexData,
  HMAP_RES,
  HMAP_RES,
  THREE.RedFormat,
  THREE.UnsignedByteType,
);
selectionTex.minFilter = THREE.LinearFilter;
selectionTex.magFilter = THREE.LinearFilter;

const groundMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(GROUND_HEX),
  roughness: 0.95,
  metalness: 0.0,
});
// Patch the standard material so the vertex shader can read our
// height texture and displace along +Y. (Easier than writing a
// fully custom shader — we still get PBR shading and shadow maps.)
groundMat.onBeforeCompile = (shader) => {
  shader.uniforms.uHeight = { value: heightTex };
  shader.uniforms.uSelection = { value: selectionTex };
  shader.uniforms.uIndentDepth = { value: INDENT_DEPTH };
  shader.uniforms.uShade = { value: new THREE.Color(GROUND_DEEP_HEX) };
  shader.uniforms.uSelectTint = { value: new THREE.Color(ROCK_SELECT_HEX) };

  shader.vertexShader =
    `
    uniform sampler2D uHeight;
    uniform float uIndentDepth;
    varying float vH;
    varying vec2 vAtlasUv;
    ` + shader.vertexShader;

  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `
      vec3 transformed = position;
      vAtlasUv = uv;
      float h = texture2D(uHeight, uv).r;
      vH = h;
      transformed.y -= h * uIndentDepth;
    `,
  );

  shader.fragmentShader =
    `
    uniform sampler2D uSelection;
    uniform vec3 uShade;
    uniform vec3 uSelectTint;
    varying float vH;
    varying vec2 vAtlasUv;
    ` + shader.fragmentShader;

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <color_fragment>",
    `
      #include <color_fragment>
      // Deepen the colour inside indents — they read as shadowed
      // troughs even before any rocks have fallen in.
      diffuseColor.rgb = mix(diffuseColor.rgb, uShade, vH * 0.65);
      float sel = texture2D(uSelection, vAtlasUv).r;
      diffuseColor.rgb = mix(diffuseColor.rgb, uSelectTint * 0.85, sel * 0.55);
    `,
  );
};
const ground = new THREE.Mesh(planeGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

// A larger "off-page" plane behind the active heightfield. Same
// material colour so the seam disappears; this is what fills the
// monitor when the viewport is wider than the heightfield.
const outerGround = new THREE.Mesh(
  new THREE.PlaneGeometry(PAGE_SIZE * 4, PAGE_SIZE * 4),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(GROUND_HEX),
    roughness: 0.97,
  }),
);
outerGround.rotation.x = -Math.PI / 2;
// Sit below the deepest indent so it never occludes the heightfield
// from the camera's angle — only visible *past* the page edges.
outerGround.position.y = -INDENT_DEPTH - 0.15;
outerGround.receiveShadow = true;
scene.add(outerGround);

// ------------------------------------------------------------------
// 5. Rapier world + terrain collider.
// ------------------------------------------------------------------
const world = new RAPIER.World({ x: 0, y: -12.0, z: 0 });
world.integrationParameters.dt = 1 / 60;

const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
let terrainCollider = null;

// Walls around the page so rocks don't escape sideways. Four thin
// vertical bars at the page edges, height tall enough to catch even
// bouncing rocks.
{
  const w = 0.05;
  const h = 1.5;
  const s = PAGE_SIZE / 2;
  const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const sides = [
    { hx: s + w, hy: h, hz: w, tx: 0, ty: h, tz:  s + w },
    { hx: s + w, hy: h, hz: w, tx: 0, ty: h, tz: -s - w },
    { hx: w, hy: h, hz: s + w, tx:  s + w, ty: h, tz: 0 },
    { hx: w, hy: h, hz: s + w, tx: -s - w, ty: h, tz: 0 },
  ];
  for (const side of sides) {
    const cd = RAPIER.ColliderDesc.cuboid(side.hx, side.hy, side.hz)
      .setTranslation(side.tx, side.ty, side.tz)
      .setFriction(0.4);
    world.createCollider(cd, wallBody);
  }
}

// The heights array Rapier expects is laid out so heights[i + j*nrows]
// is the height of the vertex at local-X index i, local-Z index j.
// Their heightfield is centered on the body's origin and extends
// scale.x in X, scale.z in Z; heights are in *units of scale.y*.
//
// Our canvas atlas has y=0 at the top of the doc. The plane's UV
// maps top-of-doc to v=1 (after our uv flip). The HEIGHTFIELD's
// local Z axis: we want world -Z to be "top of doc", which means
// the Rapier vertex at j=0 corresponds to world -Z extreme, which
// is canvas y=0.
function rebuildHeightfield() {
  renderTextToCanvas();
  sctx.fillStyle = "#000";
  sctx.fillRect(0, 0, HMAP_RES, HMAP_RES);
  sctx.drawImage(texCanvas, 0, 0, HMAP_RES, HMAP_RES);
  const data = sctx.getImageData(0, 0, HMAP_RES, HMAP_RES).data;

  // Build two arrays:
  //   - heightTexData: for the visual mesh's vertex displacement.
  //     Indexed by (row, col) where (0,0) is top-left of canvas.
  //   - heights: for Rapier. Rapier's index order in 3D is i + j*nrows,
  //     and j corresponds to local Z. So vertex (i, j) lives at
  //     world position roughly (i*dx, h, j*dz) before the body
  //     transform.
  const nrows = HMAP_RES;
  const ncols = HMAP_RES;
  const heights = new Float32Array(nrows * ncols);

  // Sample with a small box-blur so the indents have soft walls.
  function sampleSmoothed(cx, cy) {
    let acc = 0;
    let cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.max(0, Math.min(HMAP_RES - 1, cx + dx));
        const y = Math.max(0, Math.min(HMAP_RES - 1, cy + dy));
        acc += data[(y * HMAP_RES + x) * 4]; // R channel
        cnt++;
      }
    }
    return acc / cnt / 255.0; // 0..1
  }

  for (let cy = 0; cy < HMAP_RES; cy++) {
    for (let cx = 0; cx < HMAP_RES; cx++) {
      const v = sampleSmoothed(cx, cy);
      heightTexData[cy * HMAP_RES + cx] = v;

      // Rapier index: i = cx (X), j corresponds to local-Z. We want
      // canvas y=0 to map to world -Z (j=0 in Rapier local frame).
      // Rapier local Z runs -scale.z/2 to +scale.z/2 as j goes 0..ncols-1.
      // So j = cy (top of canvas = top/back of world).
      //
      // Heights are *inverted* relative to the visual mesh: the
      // vertex shader does `transformed.y -= h * uIndentDepth`, so
      // text dips down visually. Rapier reads heights as displacement
      // *above* local origin (height 1 = +scale.y), so storing v
      // directly puts the physical surface at +scale.y where the
      // visual surface is at -scale.y — rocks then settle on letter-
      // shaped bumps and look embedded inside the visible troughs.
      // Storing (1 - v) flips the physical surface to match the
      // visual: text becomes a real trough that rocks fall into.
      heights[cx + cy * nrows] = 1.0 - v;
    }
  }
  heightTex.needsUpdate = true;

  if (terrainCollider) {
    world.removeCollider(terrainCollider, false);
  }
  const hfDesc = RAPIER.ColliderDesc.heightfield(
    nrows - 1,
    ncols - 1,
    heights,
    { x: PAGE_SIZE, y: INDENT_DEPTH, z: PAGE_SIZE },
  )
    .setFriction(0.55)
    .setRestitution(0.05);
  // Rapier 3D heightfields are *centered* on their local Y axis:
  // height = 1.0 sits at +scale.y/2 above the body origin, height
  // = 0.0 sits at -scale.y/2 below it. Combined with our height
  // values (1 - v, so non-text vertices = 1, text vertices = 0),
  // putting the body at y = -INDENT_DEPTH/2 lands the non-text
  // surface at world y=0 and the bottom of a text trough at world
  // y=-INDENT_DEPTH — i.e., exactly where the visual mesh draws
  // them. Earlier we had the body at -INDENT_DEPTH on the
  // assumption that heights were bottom-anchored; that's what was
  // making stones look submerged half a depth into the surface.
  hfDesc.setTranslation(0, -INDENT_DEPTH / 2, 0);
  terrainCollider = world.createCollider(hfDesc, terrainBody);
}

// ------------------------------------------------------------------
// 6. Selection tint. Re-rasterise the doc with the selection range
//    only (no glyphs) into a separate canvas, downsample to the
//    selection texture so the ground shader can find it.
// ------------------------------------------------------------------
const selectionCanvas = document.createElement("canvas");
selectionCanvas.width = TEX;
selectionCanvas.height = TEX;
const selectionCtx = selectionCanvas.getContext("2d");

function rebuildSelectionTint() {
  selectionCtx.fillStyle = "#000";
  selectionCtx.fillRect(0, 0, TEX, TEX);
  const sel = view.state.selection.main;
  if (sel.from !== sel.to) {
    selectionCtx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    selectionCtx.textBaseline = "alphabetic";
    selectionCtx.fillStyle = "#fff";
    const selFrom = Math.min(sel.from, sel.to);
    const selTo = Math.max(sel.from, sel.to);
    let y = PADDING;
    for (let r = scrollTopRow; r < visualRows.length; r++) {
      const row = visualRows[r];
      if (selTo > row.startDocPos && selFrom <= row.endDocPos) {
        const startCol = Math.max(0, selFrom - row.startDocPos);
        const endCol = Math.min(row.text.length, selTo - row.startDocPos);
        const x1 = PADDING + selectionCtx.measureText(row.text.slice(0, startCol)).width;
        const x2 = PADDING + selectionCtx.measureText(row.text.slice(0, endCol)).width;
        const extendsPastRow = selTo > row.endDocPos;
        const xEnd = extendsPastRow ? TEX - PADDING : Math.max(x2, x1 + 20);
        selectionCtx.fillRect(x1, y, xEnd - x1, FONT_SIZE);
      }
      y += LINE_HEIGHT;
      if (y > TEX - PADDING) break;
    }
  }
  // Downsample into the data texture.
  const tmp = document.createElement("canvas");
  tmp.width = HMAP_RES;
  tmp.height = HMAP_RES;
  const tctx2 = tmp.getContext("2d");
  tctx2.drawImage(selectionCanvas, 0, 0, HMAP_RES, HMAP_RES);
  const d = tctx2.getImageData(0, 0, HMAP_RES, HMAP_RES).data;
  for (let i = 0; i < HMAP_RES * HMAP_RES; i++) {
    selectionTexData[i] = d[i * 4];
  }
  selectionTex.needsUpdate = true;
}

// ------------------------------------------------------------------
// 7. Rocks. Pool of dynamic Rapier bodies + InstancedMesh visuals.
//    Rocks are spawned slowly while the population is below a cap;
//    once a rock leaves the play area or sinks under the page it's
//    despawned and its slot becomes eligible for reuse.
// ------------------------------------------------------------------
const MAX_ROCKS = 3600;
const ROCK_R = 0.045;

// Subdivision-1 icosahedron (80 faces vs. the base 20). Smoother
// silhouette + closer-to-spherical inertia tensor means each stone
// rolls along the page instead of skidding to a halt on whichever
// flat face happens to land down.
const rockGeo = new THREE.IcosahedronGeometry(ROCK_R, 1);
const rockMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.78,
  metalness: 0.04,
});
const rocks = new THREE.InstancedMesh(rockGeo, rockMat, MAX_ROCKS);
rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
rocks.castShadow = true;
rocks.receiveShadow = true;
rocks.count = 0;
{
  const colors = new Float32Array(MAX_ROCKS * 3);
  rocks.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  rocks.instanceColor.setUsage(THREE.DynamicDrawUsage);
}
scene.add(rocks);

const rockBodies = []; // parallel to rocks[i]
const dummy = new THREE.Object3D();
const dummyColor = new THREE.Color();
const baseRock = new THREE.Color(ROCK_BASE_HEX);
const hiRock = new THREE.Color(ROCK_HI_HEX);
const selRock = new THREE.Color(ROCK_SELECT_HEX);

function spawnRock() {
  if (rockBodies.length >= MAX_ROCKS) return;
  // Even rain across the whole page so every letter trough has a
  // chance to fill; with no slope to traffic stones forward they
  // settle wherever they happen to land.
  const x = (Math.random() - 0.5) * (PAGE_SIZE * 0.92);
  const z = (Math.random() - 0.5) * (PAGE_SIZE * 0.92);
  const y = 2.0 + Math.random() * 0.5;

  const rbDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinvel(
      (Math.random() - 0.5) * 0.25,
      0,
      (Math.random() - 0.5) * 0.25,
    )
    .setAngvel({
      x: (Math.random() - 0.5) * 4,
      y: (Math.random() - 0.5) * 2,
      z: (Math.random() - 0.5) * 4,
    })
    // Continuous collision detection — without it, fast stones
    // tunnel through the thin heightfield and disappear underneath.
    .setCcdEnabled(true);
  const rb = world.createRigidBody(rbDesc);

  const rScale = 0.8 + Math.random() * 0.6;
  // Moderate friction lets stones roll on impact but still settles
  // them into deep letter troughs instead of bouncing back out.
  const cd = RAPIER.ColliderDesc.ball(ROCK_R * rScale)
    .setFriction(0.55)
    .setRestitution(0.08)
    .setDensity(2.0);
  world.createCollider(cd, rb);

  rb.__rockTint = Math.random();
  rb.__rockScale = rScale;
  rockBodies.push(rb);
}

function despawnRock(i) {
  const rb = rockBodies[i];
  world.removeRigidBody(rb);
  // Swap-remove
  rockBodies[i] = rockBodies[rockBodies.length - 1];
  rockBodies.pop();
}

// ------------------------------------------------------------------
// 8. Pointer hit testing. Raycast the (un-displaced) ground plane
//    to recover an atlas position the same way the other demos do.
// ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const flatPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(PAGE_SIZE, PAGE_SIZE, 1, 1),
  new THREE.MeshBasicMaterial({ visible: false }),
);
flatPlane.rotation.x = -Math.PI / 2;
scene.add(flatPlane);

function docPosFromPointer(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(flatPlane);
  if (!hits.length || !hits[0].uv) return null;

  const uv = hits[0].uv;
  // uv was inverted on the visual mesh; the invisible hit plane uses
  // the unflipped UV (v=0 at the bottom of the plane = world +Z =
  // bottom of doc). Convert to canvas-y top-down.
  const px = uv.x * TEX;
  const py = (1 - uv.y) * TEX;

  if (visualRows.length === 0) return null;
  const rowOffset = Math.floor((py - PADDING) / LINE_HEIGHT);
  let rowIdx = scrollTopRow + rowOffset;
  if (rowIdx < 0) rowIdx = 0;
  if (rowIdx >= visualRows.length) rowIdx = visualRows.length - 1;
  const row = visualRows[rowIdx];

  setFont();
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
// 9. Resize.
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

// ------------------------------------------------------------------
// 10. Animation loop.
//
//   - If the doc changed, rebuild the terrain heightfield + texture.
//   - If only the selection changed, rebuild just the tint texture.
//   - Spawn a few rocks per frame until we hit the population cap.
//   - Step Rapier and copy each rock's pose into the InstancedMesh.
//   - Despawn rocks that fell off the page.
// ------------------------------------------------------------------
// Spawn rate is driven by typingActivity. Idle baseline is a steady
// drizzle; the rate ramps up to a downpour when text is flowing in.
const SPAWN_INTERVAL_IDLE = 0.10;  // ~10 rocks/sec when nobody is typing
const SPAWN_INTERVAL_BUSY = 0.005; // ~200 rocks/sec at peak typing
let spawnAcc = 0;

function isInSelection(rb) {
  // Project the rock's xz back into the canvas plane and read the
  // selection texture. Cheap proxy — close enough for tint purposes.
  const t = rb.translation();
  const u = (t.x / PAGE_SIZE + 0.5) * HMAP_RES;
  const v = (t.z / PAGE_SIZE + 0.5) * HMAP_RES;
  const ui = Math.max(0, Math.min(HMAP_RES - 1, Math.floor(u)));
  const vi = Math.max(0, Math.min(HMAP_RES - 1, Math.floor(v)));
  return selectionTexData[vi * HMAP_RES + ui] > 32;
}

function tick(now) {
  if (docDirty) {
    rebuildHeightfield();
    rebuildSelectionTint();
    docDirty = false;
    selectionDirty = false;
  } else if (selectionDirty) {
    rebuildSelectionTint();
    selectionDirty = false;
  }

  const dt = 1 / 60;

  // Decay the typing meter. Half-life of roughly one second so a
  // burst of typing keeps the rain heavy for a few seconds afterwards.
  typingActivity *= Math.exp(-dt * 0.7);
  const busyness = Math.min(1, typingActivity / 12);
  const spawnInterval =
    SPAWN_INTERVAL_IDLE +
    (SPAWN_INTERVAL_BUSY - SPAWN_INTERVAL_IDLE) * busyness;

  spawnAcc += dt;
  while (spawnAcc >= spawnInterval) {
    spawnRock();
    spawnAcc -= spawnInterval;
  }

  world.step();

  // Cull rocks that ran out of bounds (off the page edge, under the
  // floor) and copy survivors into the instance buffer.
  let writeIdx = 0;
  for (let i = rockBodies.length - 1; i >= 0; i--) {
    const rb = rockBodies[i];
    const t = rb.translation();
    if (
      t.y < -3 ||
      Math.abs(t.x) > PAGE_SIZE * 0.7 ||
      Math.abs(t.z) > PAGE_SIZE * 0.7
    ) {
      despawnRock(i);
    }
  }
  for (let i = 0; i < rockBodies.length && writeIdx < MAX_ROCKS; i++) {
    const rb = rockBodies[i];
    const t = rb.translation();
    const q = rb.rotation();
    dummy.position.set(t.x, t.y, t.z);
    dummy.quaternion.set(q.x, q.y, q.z, q.w);
    dummy.scale.setScalar(rb.__rockScale);
    dummy.updateMatrix();
    rocks.setMatrixAt(writeIdx, dummy.matrix);

    const tone = rb.__rockTint;
    if (isInSelection(rb)) {
      dummyColor.copy(selRock);
    } else {
      // Full lerp between the two anchor blues so the pile actually
      // shows a visible spread of shades rather than crowding near
      // the dark end.
      dummyColor.copy(baseRock).lerp(hiRock, tone);
    }
    rocks.setColorAt(writeIdx, dummyColor);
    writeIdx++;
  }
  rocks.count = writeIdx;
  rocks.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

document.fonts.load(`${FONT_SIZE}px "Bowlby One"`).then(() => {
  rebuildHeightfield();
  rebuildSelectionTint();
  docDirty = false;
  selectionDirty = false;
  requestAnimationFrame(tick);
});
