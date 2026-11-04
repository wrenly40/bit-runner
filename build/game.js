// Bit Runner 3D — game code. Three.js r160 is concatenated directly above
// this code in the same module script, so Scene, WebGLRenderer, etc. are
// already in scope. No imports, no network needed at runtime.
"use strict";

const stage = document.getElementById("stage");
const hudScore = document.getElementById("hudScore");
const hudBest = document.getElementById("hudBest");
const hudValue = document.getElementById("hudValue");

// ---------- layout-aware key labels ----------
// The ops bind to physical positions (e.code), so they work on any layout —
// QWERTY, AZERTY, QWERTZ, Dvorak, … — but the glyph printed on those keys
// changes with the layout. Show the glyph the player's own keyboard actually
// produces at those positions (Keyboard Layout API), falling back to the
// approved X / < labels when the API is unavailable. The binding itself
// never changes: left hand ×2/+1, right hand ÷2/−1, ring fingers on the
// nudge keys.
if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
  navigator.keyboard.getLayoutMap().then((map) => {
    const plus = map.get("KeyX"), minus = map.get("Comma");
    const plusLabel = plus && plus.toLowerCase() !== "x" ? plus.toUpperCase() : "X";
    const minusLabel = minus && minus !== "," ? minus.toUpperCase() : "<";
    document.querySelectorAll(".plus-key").forEach((el) => { el.textContent = plusLabel; });
    document.querySelectorAll(".minus-key").forEach((el) => { el.textContent = minusLabel; });
  }).catch(() => {});
}

// ---------- state ----------
let running = false, over = false, reason = "";
let score = 0, best = 0, value = 7, doorsOpened = 0;
let speed = 30, speedLock = false, elapsed = 0, spawnTimer = 1.5, doorCount = 0;
let attractT = 0;
let doors = [], shake = 0, popT = 99, spinT = 99, muted = false, audioCtx = null;
let deathAnim = null, deathT = 0, sector = 0, autoSpawn = true, burstState = null, paused = false;
try { best = parseInt(localStorage.getItem("bitrunner-best") || "0") || 0; } catch (e) { best = 0; }

// Binary display: padded to 4 for small values, ellipsis for huge ones.
const bin = v => {
  const b = v.toString(2).padStart(4, "0");
  return b.length <= 16 ? b : "…" + b.slice(-15);
};
const pick = a => a[Math.floor(Math.random() * a.length)];
// Door target: a short random walk of minSteps..maxSteps operations from v.
// With +1/-1 in the mix, targets are no longer just powers-of-two chains —
// any integer a few operations away is fair game. No value cap: values grow
// freely; only reaching 0 kills you.
function walkTarget(v, minSteps, maxSteps) {
  let t = v;
  const steps = minSteps + Math.floor(Math.random() * (maxSteps - minSteps + 1));
  for (let i = 0; i < steps; i++) {
    const ops = t === 1 ? ["mul", "inc"] : ["mul", "div", "inc", "dec"];
    const op = ops[Math.floor(Math.random() * ops.length)];
    if (op === "mul") t *= 2;
    else if (op === "div") t = Math.floor(t / 2);
    else if (op === "inc") t += 1;
    else t -= 1;
  }
  return t;
}

// ---------- audio (tiny WebAudio bleeps + procedural music, no assets) ----------
let master = null, noiseBuf = null;
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (!master) {
      master = audioCtx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (!noiseBuf) {
      noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
  } catch (e) {}
}
function tone(f0, f1, dur, type, vol) {
  ensureAudio();
  if (!audioCtx || !master) return;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(t + dur);
  } catch (e) {}
}
const sfxShiftL = () => tone(440, 880, 0.12, "square", 0.05);
const sfxShiftR = () => tone(440, 220, 0.12, "square", 0.05);
const sfxPlus = () => tone(660, 880, 0.08, "square", 0.04);
const sfxMinus = () => tone(880, 660, 0.08, "square", 0.04);
const sfxOpen = () => { tone(660, 660, 0.1, "sine", 0.06); setTimeout(() => tone(990, 990, 0.14, "sine", 0.06), 80); };
const sfxCrash = () => tone(160, 60, 0.4, "sawtooth", 0.08);

// Background loop: 32 eighth-note steps (4 bars) at 112 BPM, Am–F–C–G.
// Four-on-the-floor kick, offbeat hats, clap on beats 2 & 4, a driving
// 8th-note bass with octave hops, a cycling arp, and a soft pad per bar.
const CHORDS = [
  { root: 110.00, arp: [440.00, 523.25, 659.25], pad: [220.00, 261.63, 329.63] },
  { root: 87.31,  arp: [349.23, 440.00, 523.25], pad: [174.61, 220.00, 261.63] },
  { root: 130.81, arp: [523.25, 659.25, 783.99], pad: [261.63, 329.63, 392.00] },
  { root: 98.00,  arp: [392.00, 493.88, 587.33], pad: [196.00, 246.94, 293.66] },
];
let musicTimer = null, musicStep = 0, musicNext = 0;
function musicNote(freq, t, dur, type, vol) {
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur);
  } catch (e) {}
}
function musicHat(t) {
  try {
    const s = audioCtx.createBufferSource(); s.buffer = noiseBuf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.02, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    s.connect(g); g.connect(master);
    s.start(t); s.stop(t + 0.04);
  } catch (e) {}
}
function musicKick(t) {
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.16);
  } catch (e) {}
}
function musicClap(t) {
  try {
    const s = audioCtx.createBufferSource(); s.buffer = noiseBuf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    s.connect(g); g.connect(master);
    s.start(t); s.stop(t + 0.16);
  } catch (e) {}
}
function musicPad(freq, t, dur, vol) {
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "triangle"; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.4);
    g.gain.setValueAtTime(vol, t + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur);
  } catch (e) {}
}
function scheduleMusicStep(step, t) {
  const chord = CHORDS[Math.floor(step / 8)];
  const s8 = step % 8;
  if (step % 2 === 0) musicKick(t);
  if (step % 2 === 1) musicHat(t);
  if (s8 === 2 || s8 === 6) musicClap(t);
  if (s8 === 0 || s8 === 2 || s8 === 4 || s8 === 6)
    musicNote(chord.root * (s8 === 6 ? 2 : 1), t, 0.24, "triangle", 0.14);
  if (step % 2 === 0 || sector >= 1) musicNote(chord.arp[step % 3], t, 0.12, "square", 0.03);
  if (sector >= 2 && (s8 === 0 || s8 === 4)) musicNote(chord.arp[step % 3] * 2, t, 0.2, "sine", 0.03);
  if (s8 === 0) for (const f of chord.pad) musicPad(f, t, 60 / 112 / 2 * 8, 0.04);
}
function startMusic() {
  ensureAudio();
  if (!audioCtx || musicTimer) return;
  musicStep = 0;
  musicNext = audioCtx.currentTime + 0.1;
  musicTimer = setInterval(() => {
    try {
      while (musicNext < audioCtx.currentTime + 0.3) {
        scheduleMusicStep(musicStep, musicNext);
        musicNext += 60 / 112 / 2;
        musicStep = (musicStep + 1) % 32;
      }
    } catch (e) {}
  }, 100);
}
function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}

// ---------- renderer / scene ----------
let renderer;
try {
  renderer = new WebGLRenderer({ antialias: true });
} catch (e) {
  document.getElementById("glError").style.display = "block";
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x050510);
scene.fog = new Fog(0x050510, 45, 130);
const camera = new PerspectiveCamera(55, 860 / 540, 0.1, 400);

scene.add(new HemisphereLight(0x1a2440, 0x050510, 0.7));
const sun = new DirectionalLight(0x7aa2ff, 0.5);
sun.position.set(6, 14, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -16; sun.shadow.camera.right = 16;
sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
sun.shadow.camera.far = 50;
scene.add(sun);

// Cyan light that rides with the player, so the byte glows onto the road.
const playerLight = new PointLight(0x00e5ff, 0.9, 22);
playerLight.position.set(0, 3, 0);
scene.add(playerLight);

// Post-processing: real bloom so neon actually glows instead of just
// being bright flat color. Rendered through the composer from here on.
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(devicePixelRatio, 2));
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new Vector2(860, 540), 0.85, 0.55, 0.65);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Ground + road. The road texture scrolls toward the camera: offset.y grows,
// which moves texture features toward v=0, the near (camera) end of the plane.
const ground = new Mesh(
  new PlaneGeometry(500, 500),
  new MeshStandardMaterial({ color: 0x070714, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Faint synthwave grid on the ground; the road plane sits above it and
// occludes the grid beneath the lane.
const grid = new GridHelper(400, 80, 0x00e5ff, 0x1a2b4a);
grid.position.y = 0.01;
grid.material.transparent = true;
grid.material.opacity = 0.22;
scene.add(grid);

// Stars overhead (fog off, so they stay visible).
const starGeo = new BufferGeometry();
{
  const pos = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 300;
    pos[i * 3 + 1] = 20 + Math.random() * 100;
    pos[i * 3 + 2] = -200 + Math.random() * 200;
  }
  starGeo.setAttribute("position", new BufferAttribute(pos, 3));
}
scene.add(new Points(starGeo, new PointsMaterial({ color: 0xffffff, size: 0.7, transparent: true, opacity: 0.8, fog: false })));

const roadCanvas = document.createElement("canvas");
roadCanvas.width = 256; roadCanvas.height = 1024;
function paintRoad(cLeft, cRight) {
  const c = roadCanvas.getContext("2d");
  c.fillStyle = "#161a28"; c.fillRect(0, 0, 256, 1024);
  c.fillStyle = cLeft; c.fillRect(0, 0, 10, 1024);
  c.fillStyle = cRight; c.fillRect(246, 0, 10, 1024);
  c.fillStyle = "#dff9ff";
  for (let y = 0; y < 1024; y += 256) c.fillRect(124, y + 40, 8, 130);
  roadTex.needsUpdate = true;
}
const roadTex = new CanvasTexture(roadCanvas);
roadTex.wrapT = RepeatWrapping;
roadTex.repeat.set(1, 8); // one texture repeat = 220 / 8 = 27.5 world units
paintRoad("#00e5ff", "#ff2ea6");
const road = new Mesh(
  new PlaneGeometry(12, 220),
  new MeshStandardMaterial({ map: roadTex, roughness: 0.95 })
);
road.rotation.x = -Math.PI / 2;
road.position.set(0, 0.02, -90);
road.receiveShadow = true;
scene.add(road);

const curbMatL = new MeshStandardMaterial({ color: 0x0b1220, emissive: 0x00e5ff, emissiveIntensity: 1.2, roughness: 0.9 });
const curbMatR = new MeshStandardMaterial({ color: 0x0b1220, emissive: 0xff2ea6, emissiveIntensity: 1.2, roughness: 0.9 });
for (const [sx, m] of [[-6.2, curbMatL], [6.2, curbMatR]]) {
  const curb = new Mesh(new BoxGeometry(0.4, 0.25, 220), m);
  curb.position.set(sx, 0.125, -90);
  scene.add(curb);
}

// ---------- player ----------
const pSize = v => Math.min(5, 1.2 + 0.3 * Math.log2(Math.max(1, v)));
const playerCanvas = document.createElement("canvas");
playerCanvas.width = playerCanvas.height = 256;
const playerTex = new CanvasTexture(playerCanvas);
function drawPlayer() {
  const c = playerCanvas.getContext("2d");
  c.fillStyle = "#00d0ff"; c.fillRect(0, 0, 256, 256);
  const d = String(value);
  c.fillStyle = "#04121a"; c.textAlign = "center";
  c.font = "bold " + Math.min(150, 230 / (d.length * 0.62)) + "px system-ui";
  c.fillText(d, 128, 150);
  const bb = bin(value);
  c.fillStyle = "#06303c";
  c.font = (bb.length > 12 ? 22 : 28) + "px ui-monospace, Menlo, monospace";
  c.fillText(bb, 128, 205);
  playerTex.needsUpdate = true;
}
drawPlayer();
const sideMat = new MeshStandardMaterial({ color: 0x0e1526, emissive: 0x00b8d9, emissiveIntensity: 0.5, roughness: 0.55 });
const faceMat = new MeshBasicMaterial({ map: playerTex });
// Box material order: +x, -x, +y, -y, +z (faces camera), -z.
const player = new Mesh(new BoxGeometry(1, 1, 1),
  [sideMat, sideMat, sideMat, sideMat, faceMat, sideMat]);
player.castShadow = true;
player.scale.setScalar(pSize(value));
player.position.y = pSize(value) / 2 + 0.02;
scene.add(player);

// Hologram cage: a slightly oversized neon wireframe around the byte.
const cage = new LineSegments(
  new EdgesGeometry(new BoxGeometry(1.02, 1.02, 1.02)),
  new LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.9 })
);
player.add(cage);

// Shared radial glow texture for the player and door halos.
const glowCanvas = document.createElement("canvas");
glowCanvas.width = glowCanvas.height = 128;
{
  const c = glowCanvas.getContext("2d");
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.4)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
}
const glowTex = new CanvasTexture(glowCanvas);
const playerGlowMat = new SpriteMaterial({ map: glowTex, color: 0x00e5ff, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false });
const playerGlow = new Sprite(playerGlowMat);
playerGlow.scale.setScalar(5.5);
scene.add(playerGlow);
// Roadside city: buildings with lit windows that scroll past with the world.
function makeBuildingTexture() {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 256;
  const c = cv.getContext("2d");
  c.fillStyle = "#0a0f22"; c.fillRect(0, 0, 128, 256);
  const lit = ["#00e5ff", "#ff2ea6", "#ffe9a3", "#eafcff"];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 8; x++) {
      if (Math.random() < 0.32) {
        c.fillStyle = lit[Math.floor(Math.random() * lit.length)];
      } else {
        c.fillStyle = "#141b33";
      }
      c.fillRect(2 + x * 16, 2 + y * 16, 11, 11);
    }
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}
const buildingTexes = [makeBuildingTexture(), makeBuildingTexture(), makeBuildingTexture()];
const buildingGeo = new BoxGeometry(1, 1, 1);
const buildings = [];
function spawnBuilding(b, anywhere) {
  const w = 4 + Math.random() * 6, h = 8 + Math.random() * 30, d = 4 + Math.random() * 6;
  b.mesh.scale.set(w, h, d);
  b.mesh.position.set(b.side * (11 + Math.random() * 18), h / 2,
    anywhere ? -200 + Math.random() * 220 : -200 - Math.random() * 30);
  b.tex.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 12)));
  b.tex.offset.set(Math.random(), Math.random());
}
for (let i = 0; i < 26; i++) {
  const tex = buildingTexes[i % 3].clone();
  tex.needsUpdate = true;
  const mat = new MeshStandardMaterial({ color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.7, roughness: 1 });
  const mesh = new Mesh(buildingGeo, mat);
  scene.add(mesh);
  const b = { side: i % 2 === 0 ? -1 : 1, mesh, tex };
  spawnBuilding(b, true);
  buildings.push(b);
}

// Door light pillars: tall additive beams rising from each gate post.
const pillarCanvas = document.createElement("canvas");
pillarCanvas.width = 64; pillarCanvas.height = 256;
{
  const c = pillarCanvas.getContext("2d");
  const g = c.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g; c.fillRect(0, 0, 64, 256);
}
const pillarTex = new CanvasTexture(pillarCanvas);
const pillarGeo = new PlaneGeometry(0.7, 12);

// Door kinds: normal gates, magenta chasers (a rapid second door after an
// open), and gold bonus doors (a long chain worth 500, a miss never kills).
const KIND_STYLE = {
  normal: { plate: "#00f0ff", plateBin: "#3d8ea0", glow: 0x00e5ff },
  burst: { plate: "#00f0ff", plateBin: "#3d8ea0", glow: 0x00e5ff },
  chaser: { plate: "#ff2ea6", plateBin: "#a03d7d", glow: 0xff2ea6 },
  golden: { plate: "#ffd34d", plateBin: "#8a6d1f", glow: 0xffb800 },
};
const numTexCache = new Map();
function doorTexture(n, kind) {
  const key = kind + ":" + n;
  if (numTexCache.has(key)) return numTexCache.get(key);
  if (numTexCache.size > 400) numTexCache.clear(); // long sessions must not grow the cache forever
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 176;
  const c = cv.getContext("2d");
  c.fillStyle = "#05070f"; c.fillRect(0, 0, 256, 176);
  const d = String(n);
  c.fillStyle = KIND_STYLE[kind].plate; c.textAlign = "center";
  c.font = "bold " + Math.min(104, 230 / (d.length * 0.62)) + "px system-ui";
  c.fillText(d, 128, 108);
  const bb = bin(n);
  c.fillStyle = KIND_STYLE[kind].plateBin;
  c.font = (bb.length > 12 ? 20 : 24) + "px ui-monospace, Menlo, monospace";
  c.fillText(bb, 128, 150);
  const tex = new CanvasTexture(cv);
  numTexCache.set(key, tex);
  return tex;
}
const postGeo = new BoxGeometry(0.6, 4.6, 0.6);
const beamGeo = new BoxGeometry(11, 0.8, 0.6);
const rodGeo = new BoxGeometry(0.15, 0.75, 0.15);
const numGeo = new PlaneGeometry(3.6, 2.4);
function makeDoor(target, z, kind) {
  const style = KIND_STYLE[kind];
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: 0x0e1526, emissive: style.glow, emissiveIntensity: 0.6, roughness: 0.8 });
  const rodMat = new MeshStandardMaterial({ color: 0x0e1526, emissive: style.glow, emissiveIntensity: 0.6, roughness: 0.8, transparent: true });
  const l = new Mesh(postGeo, mat); l.position.set(-5.2, 2.3, 0); l.castShadow = true;
  const r = new Mesh(postGeo, mat); r.position.set(5.2, 2.3, 0); r.castShadow = true;
  const beam = new Mesh(beamGeo, mat); beam.position.set(0, 4.6, 0); beam.castShadow = true;
  const rodL = new Mesh(rodGeo, rodMat); rodL.position.set(-1.2, 3.85, 0);
  const rodR = new Mesh(rodGeo, rodMat); rodR.position.set(1.2, 3.85, 0);
  const numMat = new MeshBasicMaterial({ map: doorTexture(target, kind), transparent: true });
  const num = new Mesh(numGeo, numMat); num.position.set(0, 2.3, 0.35);
  const glowMat = new SpriteMaterial({ map: glowTex, color: style.glow, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false });
  const glow = new Sprite(glowMat); glow.scale.setScalar(7); glow.position.set(0, 2.3, -0.6);
  const pillarMatL = new MeshBasicMaterial({ map: pillarTex, color: style.glow, transparent: true, opacity: 0.4, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
  const pillarMatR = pillarMatL.clone();
  const pillarL = new Mesh(pillarGeo, pillarMatL); pillarL.position.set(-5.2, 6, 0);
  const pillarR = new Mesh(pillarGeo, pillarMatR); pillarR.position.set(5.2, 6, 0);
  g.add(l, r, beam, rodL, rodR, num, glow, pillarL, pillarR);
  g.position.z = z;
  scene.add(g);
  return { group: g, mat, rodMat, glowMat, pillarMats: [pillarMatL, pillarMatR], rods: [rodL, rodR], numMat, posts: [l, r], beam, target, z, kind,
           resolved: false, crashed: false, opening: false, openT: 0 };
}
function setDoorGlow(d, hex) {
  d.mat.emissive.set(hex);
  d.rodMat.emissive.set(hex);
  d.glowMat.color.set(hex);
  d.pillarMats[0].color.set(hex);
  d.pillarMats[1].color.set(hex);
}

// Speed streaks: thin white lines at the road edges that fade in with speed.
const streakGeo = new BoxGeometry(0.06, 0.06, 2.2);
const streakMat = new MeshBasicMaterial({ color: 0xaef4ff, transparent: true, opacity: 0 });
const streaks = [];
function respawnStreak(m, anywhere) {
  const side = Math.random() < 0.5 ? -1 : 1;
  m.position.set(side * (6.5 + Math.random() * 6.5), 0.3 + Math.random() * 4.5,
    anywhere ? -110 + Math.random() * 120 : -110 - Math.random() * 20);
}
for (let i = 0; i < 36; i++) {
  const m = new Mesh(streakGeo, streakMat);
  respawnStreak(m, true);
  scene.add(m);
  streaks.push(m);
}
function flash(text, color, big) {
  const el = document.createElement("div");
  el.className = "flash" + (big ? " big" : "");
  el.textContent = text; el.style.color = color;
  const v = new Vector3(0, pSize(value) + 1.4, 0).project(camera);
  el.style.left = ((v.x * 0.5 + 0.5) * stage.clientWidth) + "px";
  el.style.top = ((-v.y * 0.5 + 0.5) * stage.clientHeight) + "px";
  document.getElementById("flashes").appendChild(el);
  setTimeout(() => el.remove(), big ? 1800 : 1000);
}
function pulseValue() {
  hudValue.classList.remove("pulse");
  void hudValue.offsetWidth;
  hudValue.classList.add("pulse");
}

// ---------- game flow ----------
function start() {
  running = true; over = false; reason = "";
  score = 0; value = 7; doorsOpened = 0;
  speed = 30; speedLock = false; elapsed = 0; spawnTimer = 1.5; doorCount = 0;
  shake = 0; popT = 99; spinT = 99; deathAnim = null; deathT = 0;
  sector = 0; autoSpawn = true; burstState = null; paused = false;
  applySectorVisuals();
  for (const d of doors) scene.remove(d.group);
  doors = [];
  drawPlayer();
  player.scale.setScalar(pSize(value));
  player.position.y = pSize(value) / 2 + 0.02;
  player.rotation.set(0, 0, 0);
  document.getElementById("startOverlay").style.display = "none";
  document.getElementById("overOverlay").style.display = "none";
  document.getElementById("pauseOverlay").style.display = "none";
  document.getElementById("hudLeft").style.display = "";
  document.getElementById("hudValue").style.display = "";
  ensureAudio();
  startMusic();
}
function togglePause() {
  if (!running || over) return;
  paused = !paused;
  document.getElementById("pauseOverlay").style.display = paused ? "flex" : "none";
  if (paused) stopMusic();
  else { ensureAudio(); startMusic(); }
}
function gameOver(r) {
  running = false; over = true; reason = r;
  deathAnim = r.startsWith("CRASH") ? "crash" : "null";
  deathT = 0;
  stopMusic();
  const s = Math.floor(score);
  if (s > best) {
    best = s;
    try { localStorage.setItem("bitrunner-best", String(best)); } catch (e) {}
  }
  document.getElementById("overReason").textContent = r;
  document.getElementById("overScore").textContent =
    "Score " + s + " · Best " + best + " · Doors opened " + doorsOpened + " · Sector " + (sector + 1);
  document.getElementById("overOverlay").style.display = "flex";
}
function shiftLeft() {
  if (!running || paused) return;
  value *= 2; drawPlayer(); popT = 0; spinT = 0; pulseValue(); sfxShiftL(); flash("×2", "#00e5ff");
}
function shiftRight() {
  if (!running || paused) return;
  const nv = Math.floor(value / 2);
  if (nv === 0) { flash("NULL!", "#ff3860"); sfxCrash(); gameOver("NULL — you shifted yourself out of existence"); return; }
  value = nv; drawPlayer(); popT = 0; spinT = 0; pulseValue(); sfxShiftR(); flash("÷2", "#ff2ea6");
}
function shiftPlus() {
  if (!running || paused) return;
  value += 1; drawPlayer(); popT = 0; pulseValue(); sfxPlus(); flash("+1", "#a5f3fc");
}
function shiftMinus() {
  if (!running || paused) return;
  const nv = value - 1;
  if (nv === 0) { flash("NULL!", "#ff3860"); sfxCrash(); gameOver("NULL — you shifted yourself out of existence"); return; }
  value = nv; drawPlayer(); popT = 0; pulseValue(); sfxMinus(); flash("−1", "#fbcfe8");
}
function spawnDoor() {
  doorCount++;
  if (doorCount === 1) { doors.push(makeDoor(value, -95, "normal")); return; }
  if (doorsOpened >= 3 && Math.random() < 0.22) { spawnBurst(); return; }
  let kind = "normal";
  if (doorsOpened >= 5 && Math.random() < 0.08) kind = "golden";
  const target = kind === "golden" ? walkTarget(value, 5, 7) : walkTarget(value, 1, 4);
  doors.push(makeDoor(target, -95, kind));
}
// Combo burst: 3-4 doors nose-to-tail, 0.6s of travel apart, each target
// exactly one shift (x2 or /2) from the previous one. One keypress per
// door, in rhythm — and clearing the whole burst pays a +200 bonus.
function spawnBurst() {
  const n = 3 + Math.floor(Math.random() * 2);
  const gap = speed * 0.6;
  let t = walkTarget(value, 1, 2);
  burstState = { total: n, opened: 0 };
  for (let i = 0; i < n; i++) {
    if (i > 0) t = t === 1 ? 2 : (Math.random() < 0.5 ? t * 2 : Math.floor(t / 2));
    doors.push(makeDoor(t, -95 - i * gap, "burst"));
  }
}
function resolve(d) {
  if (over) return; // a crash mid-frame must not let a later door in the same frame still resolve
  d.resolved = true;
  if (value === d.target) {
    doorsOpened++;
    let pts = d.kind === "golden" ? 500 : d.kind === "chaser" ? 100 : 50;
    let label = d.kind === "golden" ? "GOLD!" : d.kind === "chaser" ? "CHASER!" : "OPEN!";
    if (d.kind === "burst" && burstState) {
      burstState.opened++;
      if (burstState.opened === burstState.total) { pts += 200; label = "COMBO!"; burstState = null; }
    }
    score += pts;
    d.opening = true; setDoorGlow(d, 0x39ff88);
    flash(label, d.kind === "golden" ? "#ffd34d" : "#39ff88");
    sfxOpen();
    if (d.kind === "normal") maybeSpawnChaser(d);
    checkSector();
  } else if (d.kind === "golden") {
    // Bonus door: a miss just fades, never kills.
    setDoorGlow(d, 0x666666);
    flash("MISS", "#9ca3af");
  } else {
    d.crashed = true; setDoorGlow(d, 0xff3860);
    shake = 1; flash("WRONG!", "#ff3860"); sfxCrash();
    gameOver("CRASH — door needed " + d.target + ", you are " + value);
  }
}
// After a normal open, sometimes a magenta chaser appears 1.4s of travel
// behind it: a rapid second door whose target is 1-2 shifts from the one
// you just matched. Only when no other door is pending, and the next normal
// spawn waits at least 2s so the pair never piles up.
function maybeSpawnChaser(d) {
  if (doorsOpened < 3 || Math.random() >= 0.3) return;
  if (doors.some(o => o !== d && !o.resolved)) return;
  let t = walkTarget(d.target, 1, 2);
  for (let i = 0; i < 3 && t === d.target; i++) t = walkTarget(d.target, 1, 2);
  doors.push(makeDoor(t, -speed * 1.4, "chaser"));
  spawnTimer = Math.max(spawnTimer, 2.0);
}
// Sectors: every 10 opens the world shifts — new sky, new rail colors,
// a higher speed floor (speed itself caps at 100, so late sectors stay
// fair: every door still gives a human enough time to read and solve it).
// The door colors never change, so kinds stay readable across every sector.
const SECTOR_BG = ["#050510", "#0d0518", "#02141a", "#180512", "#171003"];
const SECTOR_RAILS = [
  ["#00e5ff", "#ff2ea6"],
  ["#8b5cf6", "#00e5ff"],
  ["#a3e635", "#ff2ea6"],
  ["#fbbf24", "#00e5ff"],
  ["#f472b6", "#a3e635"],
];
function applySectorVisuals() {
  scene.background = new Color(SECTOR_BG[sector % SECTOR_BG.length]);
  scene.fog.color.set(SECTOR_BG[sector % SECTOR_BG.length]);
  const rails = SECTOR_RAILS[sector % SECTOR_RAILS.length];
  paintRoad(rails[0], rails[1]);
  curbMatL.emissive.set(rails[0]);
  curbMatR.emissive.set(rails[1]);
}
function checkSector() {
  const s = Math.floor(doorsOpened / 10);
  if (s > sector) {
    sector = s;
    applySectorVisuals();
    flash("SECTOR " + (sector + 1) + "!", "#ffd34d", true);
  }
}

// ---------- loop ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
window.addEventListener("resize", resize);
resize();

let last = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  if (running && !paused) {
    elapsed += dt;
    if (!speedLock) speed = Math.min(100, 30 + sector * 8 + elapsed * 0.6);
    score += dt * 10;
    roadTex.offset.y = (roadTex.offset.y + speed * dt / 27.5) % 1;
    if (autoSpawn) {
      spawnTimer -= dt;
      if (spawnTimer <= 0 && !doors.some(d => (d.kind === "chaser" || d.kind === "burst") && !d.resolved)) {
        spawnDoor(); spawnTimer = Math.max(1.6, 2.2 - sector * 0.15) + Math.random() * 0.4;
      }
    }
    for (const d of doors) {
      d.z += speed * dt;
      d.group.position.z = d.z;
      if (d.opening) {
        // Burst gates snap open faster: the next number in a burst is hidden
        // behind the gate ahead of it, so it must be readable the moment the
        // previous gate clears (0.45s of the 0.6s gap, instead of 0.25s).
        d.openT += dt * (d.kind === "burst" ? 0.35 / 0.15 : 1);
        const k = Math.min(1, d.openT / 0.35);
        d.posts[0].position.x = -5.2 - k * 3;
        d.posts[1].position.x = 5.2 + k * 3;
        d.beam.position.y = 4.6 + k * 3.5;
        d.rods[0].position.y = 3.85 + k * 3.5;
        d.rods[1].position.y = 3.85 + k * 3.5;
        d.rodMat.opacity = 1 - k;
        d.glowMat.opacity = 0.35 * (1 - k);
        d.pillarMats[0].opacity = 0.4 * (1 - k);
        d.pillarMats[1].opacity = 0.4 * (1 - k);
        d.numMat.opacity = 1 - k;
      }
      if (!d.resolved && d.z >= 0) resolve(d);
    }
    doors = doors.filter(d => {
      const keep = d.z < 16 && !(d.opening && d.openT > 0.4);
      if (!keep) scene.remove(d.group);
      return keep;
    });
    if (popT < 0.18) popT += dt;
    const s = pSize(value) * (popT < 0.18 ? 1 + 0.18 * Math.sin(Math.PI * popT / 0.18) : 1);
    player.scale.setScalar(s);
    player.position.y = s / 2 + 0.02 + Math.sin(elapsed * 3) * 0.05;
    // Full-turn spin on every shift; slight forward lean and a widening
    // field of view as speed builds.
    if (spinT < 0.3) {
      spinT += dt;
      player.rotation.y = Math.min(1, spinT / 0.3) * Math.PI * 2;
    } else player.rotation.y = 0;
    player.rotation.x = Math.min((speed - 30) / 40, 1.5) * 0.08;
    const targetFov = 55 + Math.min((speed - 30) / 40, 1.5) * 8;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }
    streakMat.opacity = Math.min(0.45, Math.max(0, (speed - 30) / 40) * 0.45);
    for (const m of streaks) {
      m.position.z += speed * 1.6 * dt;
      if (m.position.z > 12) respawnStreak(m, false);
    }
    for (const b of buildings) {
      b.mesh.position.z += speed * dt;
      if (b.mesh.position.z > 25) spawnBuilding(b, false);
    }
  } else if (!running && !over) {
    // Attract mode: before the first run, the world idles behind the
    // welcome card — road scrolling, city drifting past, byte bobbing —
    // so the welcome page IS the game, already running.
    attractT += dt;
    const aSpeed = 45;
    roadTex.offset.y = (roadTex.offset.y + aSpeed * dt / 27.5) % 1;
    for (const m of streaks) {
      m.position.z += aSpeed * 1.6 * dt;
      if (m.position.z > 12) respawnStreak(m, false);
    }
    for (const b of buildings) {
      b.mesh.position.z += aSpeed * dt;
      if (b.mesh.position.z > 25) spawnBuilding(b, false);
    }
    player.position.y = pSize(value) / 2 + 0.02 + Math.sin(attractT * 3) * 0.05;
    streakMat.opacity = 0.17;
  } else streakMat.opacity = 0;
  // Death animations run after the run ends: crash knocks the byte flat,
  // NULL shrinks it out of existence.
  if (over && deathAnim) {
    deathT += dt;
    if (deathAnim === "crash") {
      player.rotation.y = 0;
      player.rotation.x = -Math.min(1, deathT / 0.5) * Math.PI / 2;
      player.position.y = pSize(value) / 2 + 0.02;
    } else {
      const k = Math.max(0, 1 - deathT / 0.4);
      player.scale.setScalar(pSize(value) * k);
      player.position.y = (pSize(value) * k) / 2 + 0.02;
    }
  }
  if (shake > 0) shake = Math.max(0, shake - dt * 1.5);
  camera.position.set((Math.random() - 0.5) * 0.5 * shake, 7, 11);
  camera.lookAt(0, 1.5, -14);
  playerGlow.position.set(0, player.position.y + 0.5, 0);
  hudScore.textContent = Math.floor(score);
  hudBest.textContent = best;
  hudValue.textContent = bin(value) + " · " + value;
  composer.render();
}
requestAnimationFrame(loop);

// ---------- dev hook for the automated playthrough ----------
window.__demo = () => ({
  running, over, reason, score: Math.floor(score), best, value, binary: bin(value),
  speed: Math.round(speed), doorsOpened, roadOffset: roadTex.offset.y,
  rotX: player.rotation.x, pScale: player.scale.x,
  rotY: player.rotation.y, fov: camera.fov, streakOpacity: streakMat.opacity,
  buildings: buildings.length, musicStep, sector, paused, elapsed,
  music: musicTimer !== null, muted,
  doors: doors.map(d => ({ target: d.target, z: Math.round(d.z), resolved: d.resolved, kind: d.kind })),
});
window.__demo.setValue = (v) => { if (v >= 1) { value = v; drawPlayer(); } };
window.__demo.setSpeed = (s) => { speed = s; speedLock = true; };
window.__demo.setAutoSpawn = (on) => { autoSpawn = on; };
window.__demo.spawnDoor = (target, z, kind) => { doors.push(makeDoor(target, z === undefined ? -95 : z, kind || "normal")); };
window.__demo.spawnBurst = () => spawnBurst();
window.__demo.restart = () => start();

// ---------- input ----------
document.getElementById("startBtn").addEventListener("click", start);
document.getElementById("againBtn").addEventListener("click", start);
document.getElementById("resumeBtn").addEventListener("click", togglePause);
document.getElementById("pauseRestartBtn").addEventListener("click", start);
document.getElementById("pauseSoundBtn").addEventListener("click", (e) => {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 1;
  e.target.textContent = muted ? "Sound: off" : "Sound: on";
});
document.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "ShiftLeft") shiftLeft();
  else if (e.code === "ShiftRight") shiftRight();
  else if (e.code === "KeyX") shiftPlus();
  else if (e.code === "Comma") shiftMinus();
  else if (e.code === "ArrowUp") { e.preventDefault(); shiftPlus(); }
  else if (e.code === "ArrowDown") { e.preventDefault(); shiftMinus(); }
  else if (e.code === "Escape") togglePause();
  else if ((e.key === "r" || e.key === "R") && (over || !running)) start();
});
