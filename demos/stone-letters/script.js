import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import * as THREE from "https://esm.sh/three@0.160.0";
import RAPIER from "https://esm.sh/@dimforge/rapier3d-compat@0.13.0";

// ------------------------------------------------------------------
// 0. Palette — dark slate-blue ground, stones in a range of warm
//    browns. Inverted from the original light-page / blue-stones
//    treatment: the dark background pushes each lit stone forward.
// ------------------------------------------------------------------
const SKY_HEX = "#1c2638";
const HORIZON_HEX = "#0e1422";
const GROUND_HEX = "#1c2638";
const GROUND_DEEP_HEX = "#0c1322";

// Two anchor browns; per-stone tint randomly slides between them so
// the pile reads as many shades of one colour family rather than a
// single uniform tone.
const ROCK_BASE_HEX = "#6b4a2a";
const ROCK_HI_HEX = "#d8b88a";
const ROCK_SELECT_HEX = "#4ea3c4";

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

// Stones spawn per-keystroke: each inserted printable character
// drops a small grid of stones over that letter's strokes. Each stone
// remembers the doc position of its parent character, and when that
// character is later deleted the stones tied to it are flagged to
// fade out (see stoneMeta + the docChange handler below).
const pendingSpawns = []; // [docPos, ...] queued for the next tick

// Resolved grid positions waiting on their cascade-stagger timer.
// Each entry: { wx, wy, wz, docPos, spawnAt (ms) }. Drained each frame
// in the animation loop; cancelled / remapped from the docChange
// handler so deleting a letter mid-cascade halts its pending drops.
const pendingDrops = [];
const CASCADE_DURATION_MS = 1000;

const view = new EditorView({
  doc: initialDoc,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        docDirty = true;
        // 1. Any stone whose docPos lies inside a *deleted* range
        //    loses its letter — mark it fading.
        u.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          if (toA > fromA) {
            for (const m of stoneMeta) {
              if (!m.fading && m.docPos >= fromA && m.docPos < toA) {
                m.fading = true;
                m.fadeStart = performance.now();
              }
            }
            // Drop any queued drops whose parent letter just got deleted.
            for (let i = pendingDrops.length - 1; i >= 0; i--) {
              const p = pendingDrops[i];
              if (p.docPos >= fromA && p.docPos < toA) {
                pendingDrops.splice(i, 1);
              }
            }
          }
          // Queue inserts for spawning (positions in NEW doc).
          const s = inserted.toString();
          for (let i = 0; i < s.length; i++) {
            const ch = s.charAt(i);
            if (ch === "\n" || ch === " " || ch === "\t") continue;
            pendingSpawns.push(fromB + i);
          }
        });
        // 2. Surviving stones + queued drops: remap their doc positions
        //    through the transaction so they continue to point at the
        //    same letter after the document shifts.
        for (const m of stoneMeta) {
          if (!m.fading) m.docPos = u.changes.mapPos(m.docPos, 1);
        }
        for (const p of pendingDrops) {
          p.docPos = u.changes.mapPos(p.docPos, 1);
        }
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
// sun sits nearly overhead so each stone's shadow lands directly
// under it — a low raking sun reads as the stones hovering above the
// page because the shadow projects several centimetres away.
scene.add(new THREE.HemisphereLight(0xfff4d4, GROUND_DEEP_HEX, 0.55));
const sun = new THREE.DirectionalLight(0xfff3c8, 1.4);
sun.position.set(2.0, 9.0, 1.5);
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
// The downsampled atlas, cached at module scope so the per-keystroke
// stone burst can reject-sample its spawn positions against actual
// stroke pixels (rather than the letter's geometric centre, which
// for hollow letters like O/A/D is *not* a trough).
let atlasSamples = null;

function rebuildHeightfield() {
  renderTextToCanvas();
  sctx.fillStyle = "#000";
  sctx.fillRect(0, 0, HMAP_RES, HMAP_RES);
  sctx.drawImage(texCanvas, 0, 0, HMAP_RES, HMAP_RES);
  const data = sctx.getImageData(0, 0, HMAP_RES, HMAP_RES).data;
  atlasSamples = data;

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

      // Rapier / parry3d heightfields use (i, j) where i is the row
      // index along *local Z* and j is the column index along
      // *local X* (verified against parry3d's heightfield3.rs:
      // `x = -0.5 + cell_width * j`, `z = -0.5 + cell_height * i`).
      // Column-major flat layout: heights[i + j * nrows].
      //
      // We want canvas X (cx) → world X and canvas Y (cy) → world Z,
      // so i = cy and j = cx ⇒ flat index = cy + cx * nrows.
      //
      // Heights are *inverted* relative to the visual mesh: the
      // vertex shader does `transformed.y -= h * uIndentDepth`, so
      // text dips down visually. Rapier's heightfield is
      // bottom-anchored — a stored height of 0 sits at the body
      // origin, 1 sits at body.y + scale.y. Storing (1 - v) gives a
      // surface of *height 1* at non-text and *height 0* at text.
      // With the body at y = -INDENT_DEPTH (below), the non-text
      // surface lands at world y = 0 and trough floors at y =
      // -INDENT_DEPTH, exactly matching the visual displacement.
      heights[cy + cx * nrows] = 1.0 - v;
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
  // See the height-encoding comment above: the heightfield is
  // bottom-anchored, so dropping the body to -INDENT_DEPTH places the
  // non-text vertices (stored = 1) at world y=0 and the text vertices
  // (stored = 0) at world y=-INDENT_DEPTH.
  hfDesc.setTranslation(0, -INDENT_DEPTH, 0);
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
const ROCK_R = 0.0225;

// Subdivision-2 icosahedron (320 faces). At detail=1 the polygonal
// silhouette is just visible enough that each stone reads as
// hovering above its shadow; the smoother shape closes that gap.
const rockGeo = new THREE.IcosahedronGeometry(ROCK_R, 2);
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
// Parallel to rockBodies. Each entry tracks the parent letter so
// stones can fade away when their character is deleted.
//   docPos    — current doc position of the parent character (remapped
//               through every transaction)
//   fading    — once true, this stone is on its way out
//   fadeStart — performance.now() when fading began
//   collider  — Rapier collider handle, used to turn off contacts at
//               fade start so the dying stone doesn't shove neighbours
const stoneMeta = [];
const dummy = new THREE.Object3D();
const dummyColor = new THREE.Color();
const baseRock = new THREE.Color(ROCK_BASE_HEX);
const hiRock = new THREE.Color(ROCK_HI_HEX);
const selRock = new THREE.Color(ROCK_SELECT_HEX);

const FADE_DURATION_MS = 450;

function spawnRockAt(x, y, z, docPos, originX, originZ) {
  if (rockBodies.length >= MAX_ROCKS) return;
  const rbDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinvel(
      (Math.random() - 0.5) * 0.08,
      0,
      (Math.random() - 0.5) * 0.08,
    )
    .setAngvel({
      x: (Math.random() - 0.5) * 4,
      y: (Math.random() - 0.5) * 2,
      z: (Math.random() - 0.5) * 4,
    })
    .setCcdEnabled(true);
  const rb = world.createRigidBody(rbDesc);

  const rScale = 0.85 + Math.random() * 0.4;
  // Higher density (5.0 vs the old 2.0) makes each stone *feel*
  // heavier on impact — they thunk into the trough instead of
  // bouncing around like marbles. Friction stays low so anything
  // landing on a stroke wall still rolls inward.
  const cd = RAPIER.ColliderDesc.ball(ROCK_R * rScale)
    .setFriction(0.25)
    .setRestitution(0.05)
    .setDensity(5.0);
  const collider = world.createCollider(cd, rb);

  rb.__rockTint = Math.random();
  rb.__rockScale = rScale;
  rockBodies.push(rb);
  stoneMeta.push({
    docPos,
    fading: false,
    fadeStart: 0,
    collider,
    // World offset from the parent letter's current centre. Stored so
    // we can translate the stone alongside its letter whenever the
    // document re-flows (e.g. a word wraps to a new line).
    offsetX: x - originX,
    offsetZ: z - originZ,
    lastOriginX: originX,
    lastOriginZ: originZ,
  });
}

// World-space centre of the character at docPos in the *current*
// layout, or null if it isn't in the visible scrolled region. The
// stone-cascade spawn and the per-frame "stones follow their letter"
// translation both read from this.
function letterWorldCenter(docPos) {
  if (visualRows.length === 0) return null;
  let rowIdx = -1;
  for (let i = 0; i < visualRows.length; i++) {
    const r = visualRows[i];
    if (r.startDocPos <= docPos && docPos < r.endDocPos) {
      rowIdx = i;
      break;
    }
    if (r.startDocPos <= docPos && docPos === r.endDocPos) rowIdx = i;
  }
  if (rowIdx < 0) return null;
  const visibleRowCount = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
  if (rowIdx < scrollTopRow || rowIdx >= scrollTopRow + visibleRowCount) {
    return null;
  }
  const row = visualRows[rowIdx];
  const col = Math.max(0, Math.min(row.text.length - 1, docPos - row.startDocPos));
  setFont();
  const x1 = PADDING + tctx.measureText(row.text.slice(0, col)).width;
  const x2 = PADDING + tctx.measureText(row.text.slice(0, col + 1)).width;
  const cx = (x1 + x2) / 2;
  const cy = PADDING + (rowIdx - scrollTopRow) * LINE_HEIGHT + FONT_SIZE * 0.5;
  return {
    x: (cx / TEX - 0.5) * PAGE_SIZE,
    z: (cy / TEX - 0.5) * PAGE_SIZE,
  };
}

// Spacing between grid cells, in world units. Sized so two stones
// fit comfortably across a typical Bowlby One stroke (~0.18 wide at
// FONT_SIZE=110) without overlapping at spawn.
const GRID_SPACING_WORLD = 0.075;

// Drop a regular grid of stones over the typed letter's strokes.
// The grid is sized to the glyph's atlas bounding box — wide letters
// get more stones than narrow ones — and each grid cell only spawns
// a stone if the cell's centre lands on an actual stroke pixel in
// the rasterised atlas (so hollow centres in O / A / D / B don't
// produce stones that miss the trough entirely).
function spawnBurstAtDocPos(docPos) {
  if (visualRows.length === 0 || !atlasSamples) return false;
  let rowIdx = -1;
  for (let i = 0; i < visualRows.length; i++) {
    const r = visualRows[i];
    if (r.startDocPos <= docPos && docPos < r.endDocPos) {
      rowIdx = i;
      break;
    }
    // Type at end-of-row falls into endDocPos; accept the last match.
    if (r.startDocPos <= docPos && docPos === r.endDocPos) rowIdx = i;
  }
  if (rowIdx < 0) return false;
  const visibleRowCount = Math.floor((TEX - 2 * PADDING) / LINE_HEIGHT);
  if (rowIdx < scrollTopRow || rowIdx >= scrollTopRow + visibleRowCount) {
    return false;
  }

  const row = visualRows[rowIdx];
  const col = Math.max(0, Math.min(row.text.length - 1, docPos - row.startDocPos));
  setFont();
  // Glyph bounding box in atlas (TEX-space) pixels. X from the
  // measured advance widths; Y spans the row's text band.
  const x1 = PADDING + tctx.measureText(row.text.slice(0, col)).width;
  const x2 = PADDING + tctx.measureText(row.text.slice(0, col + 1)).width;
  const rowTopY = PADDING + (rowIdx - scrollTopRow) * LINE_HEIGHT;
  const yTop = rowTopY + FONT_SIZE * 0.05;
  const yBot = rowTopY + FONT_SIZE * 0.95;

  // Translate the world-units grid spacing into atlas pixels.
  const stepPx = GRID_SPACING_WORLD * TEX / PAGE_SIZE;
  const nx = Math.max(1, Math.round((x2 - x1) / stepPx));
  const ny = Math.max(1, Math.round((yBot - yTop) / stepPx));
  const dx = (x2 - x1) / nx;
  const dy = (yBot - yTop) / ny;
  const jitterPx = stepPx * 0.18;

  // Letter centre, used as the *anchor* the resulting stones are
  // stored relative to. If the letter later wraps to a new line we
  // can re-place every stone by its (offsetX, offsetZ) from the
  // letter's updated centre.
  const origin = letterWorldCenter(docPos);
  if (!origin) return false;

  // Collect every grid cell that lands on a stroke pixel, then
  // shuffle so the cascade reads as a scattering of drops rather
  // than a left-to-right wipe.
  const slots = [];
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const sx = x1 + (gx + 0.5) * dx + (Math.random() - 0.5) * jitterPx;
      const sy = yTop + (gy + 0.5) * dy + (Math.random() - 0.5) * jitterPx;
      const hx = Math.max(0, Math.min(HMAP_RES - 1, Math.floor(sx * HMAP_RES / TEX)));
      const hy = Math.max(0, Math.min(HMAP_RES - 1, Math.floor(sy * HMAP_RES / TEX)));
      if (atlasSamples[(hy * HMAP_RES + hx) * 4] < 120) continue;
      const wx = (sx / TEX - 0.5) * PAGE_SIZE;
      const wz = (sy / TEX - 0.5) * PAGE_SIZE;
      slots.push({ offsetX: wx - origin.x, offsetZ: wz - origin.z });
    }
  }
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp;
  }

  const baseTime = performance.now();
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const tFrac = slots.length > 1 ? i / (slots.length - 1) : 0;
    pendingDrops.push({
      offsetX: s.offsetX,
      offsetZ: s.offsetZ,
      // Low drop — stones release from just above the page so they
      // settle into the trough they were aimed at instead of bouncing
      // back out from a hard landing.
      wy: 0.30 + Math.random() * 0.08,
      docPos,
      spawnAt: baseTime + tFrac * CASCADE_DURATION_MS,
    });
  }
  return slots.length > 0;
}

function despawnRock(i) {
  const rb = rockBodies[i];
  world.removeRigidBody(rb);
  // Swap-remove, keeping stoneMeta in lockstep with rockBodies.
  const last = rockBodies.length - 1;
  rockBodies[i] = rockBodies[last];
  rockBodies.pop();
  stoneMeta[i] = stoneMeta[last];
  stoneMeta.pop();
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
//   - If the doc changed, rebuild the terrain heightfield + texture,
//     then drain any pending per-keystroke stone bursts so they spawn
//     against the *new* letter positions.
//   - If only the selection changed, rebuild just the tint texture.
//   - Step Rapier and copy each rock's pose into the InstancedMesh.
//   - Despawn rocks that fell off the page.
// ------------------------------------------------------------------
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
    // Now that visualRows reflects the latest text, drop the queued
    // bursts onto each typed letter.
    if (pendingSpawns.length > 0) {
      for (const docPos of pendingSpawns) spawnBurstAtDocPos(docPos);
      pendingSpawns.length = 0;
    }
    // Stones follow their letter through layout changes (word wrap,
    // text re-flow). For each non-fading stone, recompute its parent
    // letter's current centre and translate the body by the delta
    // since we last placed it.
    const originByDocPos = new Map();
    for (let i = 0; i < rockBodies.length; i++) {
      const m = stoneMeta[i];
      if (m.fading) continue;
      let origin = originByDocPos.get(m.docPos);
      if (origin === undefined) {
        origin = letterWorldCenter(m.docPos);
        originByDocPos.set(m.docPos, origin);
      }
      if (!origin) continue; // off-screen; leave the stone in place
      const dx = origin.x - m.lastOriginX;
      const dz = origin.z - m.lastOriginZ;
      if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) {
        const rb = rockBodies[i];
        const p = rb.translation();
        rb.setTranslation({ x: p.x + dx, y: p.y, z: p.z + dz }, true);
        m.lastOriginX = origin.x;
        m.lastOriginZ = origin.z;
      }
    }
  } else if (selectionDirty) {
    rebuildSelectionTint();
    selectionDirty = false;
  }

  world.step();

  const nowMs = performance.now();

  // Drain the cascade queue: spawn any stones whose stagger timer
  // has elapsed. Each drop holds an offset *from its letter's centre*
  // so a letter that wrapped between queuing and spawning still gets
  // its stones in the right place.
  for (let i = pendingDrops.length - 1; i >= 0; i--) {
    const d = pendingDrops[i];
    if (d.spawnAt > nowMs) continue;
    const origin = letterWorldCenter(d.docPos);
    if (!origin) {
      // Letter scrolled out of view before its stone could spawn —
      // drop the entry rather than dumping stones at world origin.
      pendingDrops.splice(i, 1);
      continue;
    }
    spawnRockAt(
      origin.x + d.offsetX,
      d.wy,
      origin.z + d.offsetZ,
      d.docPos,
      origin.x,
      origin.z,
    );
    pendingDrops.splice(i, 1);
  }

  // First pass (reverse): cull rocks that fell off the page and any
  // fading rocks whose fade duration has elapsed.
  for (let i = rockBodies.length - 1; i >= 0; i--) {
    const rb = rockBodies[i];
    const m = stoneMeta[i];
    const t = rb.translation();
    if (
      t.y < -3 ||
      Math.abs(t.x) > PAGE_SIZE * 0.7 ||
      Math.abs(t.z) > PAGE_SIZE * 0.7
    ) {
      despawnRock(i);
      continue;
    }
    if (m.fading && nowMs - m.fadeStart >= FADE_DURATION_MS) {
      despawnRock(i);
    }
  }

  // Second pass: write transforms + colours. Just-marked fading
  // stones get their collider switched to a sensor so they stop
  // shoving neighbours while they shrink out.
  let writeIdx = 0;
  for (let i = 0; i < rockBodies.length && writeIdx < MAX_ROCKS; i++) {
    const rb = rockBodies[i];
    const m = stoneMeta[i];
    const t = rb.translation();
    const q = rb.rotation();

    let fadeScale = 1;
    if (m.fading) {
      if (!m.sensorSet) {
        m.collider.setSensor(true);
        m.sensorSet = true;
      }
      const u = Math.min(1, (nowMs - m.fadeStart) / FADE_DURATION_MS);
      // Ease-in cubic so the shrink starts gentle and accelerates;
      // a linear ramp reads as the stones snapping out.
      fadeScale = 1 - u * u * u;
    }

    dummy.position.set(t.x, t.y, t.z);
    dummy.quaternion.set(q.x, q.y, q.z, q.w);
    dummy.scale.setScalar(rb.__rockScale * fadeScale);
    dummy.updateMatrix();
    rocks.setMatrixAt(writeIdx, dummy.matrix);

    const tone = rb.__rockTint;
    if (isInSelection(rb)) {
      dummyColor.copy(selRock);
    } else {
      // Full lerp between the two anchor browns so the pile shows a
      // visible spread of tones rather than crowding near one end.
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
  // Seed bursts for every printable character already in the doc, so
  // the page opens with stones filling the initial text instead of a
  // bare set of empty troughs.
  const seedText = view.state.doc.toString();
  for (let i = 0; i < seedText.length; i++) {
    const ch = seedText.charAt(i);
    if (ch === "\n" || ch === " " || ch === "\t") continue;
    spawnBurstAtDocPos(i);
  }
  requestAnimationFrame(tick);
});
