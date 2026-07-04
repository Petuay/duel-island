import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------- Socket & UI plumbing ----------
const socket = io();

// ---------- 3D character models (pick one of these) ----------
const MODEL_HEIGHT = 1.35;   // world height each model is scaled to fit
const MODEL_FACE_Y = 0;      // extra yaw so a model faces its aim (+Z); flip to Math.PI if backwards
const CHARACTERS = [
  { id: 'buddha', name: 'บุดด้า' },
  { id: 'jesus', name: 'จีซัส' },
  { id: 'kongming', name: 'ขงเบ้ง' }
];
const charTemplates = {};    // id -> { scene, animations }
const charMixers = [];       // { mixer, mesh } — updated each frame, pruned when the mesh leaves the scene
let selfChar = 'buddha';
(() => {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  CHARACTERS.forEach(c => loader.load(`models/${c.id}.glb`,
    gltf => { charTemplates[c.id] = { scene: gltf.scene, animations: gltf.animations }; },
    undefined,
    err => console.warn('[char] load failed:', c.id, err)));
})();

function clipByName(tpl, name) {
  return tpl && tpl.animations ? (tpl.animations.find(a => a.name === name) || null) : null;
}
let selfId = null;
let roomCode = null;
let isHost = false;
let currentIslandSize = 16;
let currentRound = 1;

// ---------- Special cards (dealt one per round) ----------
const CARDS = [
  { id: 'gobig', emoji: '🐘', name: 'เบิ้ม ๆ', desc: 'ขยายร่างเป้า +70% โดนง่ายขึ้น แต่กระสุนก็ใหญ่ขึ้น (ลุ้น 10% ใหญ่ 200%) • ซ้อนกันได้' },
  { id: 'gosmall', emoji: '🐜', name: 'จิ๋ว ๆ', desc: 'ย่อร่างเป้าเล็กลง โดนยากขึ้น (ลุ้น 10% เล็กสุด ๆ) • ซ้อนกันได้' },
  { id: 'divine', emoji: '😇', name: 'ลูกซองแฉก', desc: 'กระสุนเป้าแตกเป็นแฉก 30° ยิงออกสองนัด' },
  { id: 'bounce', emoji: '🎾', name: 'กระสุนเด้ง', desc: 'กระสุนเป้าเด้งได้ 1 ครั้งแบบสุ่ม' },
  { id: 'thunder', emoji: '⚡', name: 'ฟ้าฝนไม่เป็นใจ', desc: '50% ปืนขัดข้อง / 50% ปล่อยสายฟ้ารอบตัว 1 บล็อก' },
  { id: 'mirror', emoji: '🪞', name: 'กระจกหกด้าน', desc: 'เป้าได้เกราะหนาม สะท้อนกระสุนกลับไปหาคนยิง' },
  { id: 'wall', emoji: '🧱', name: 'กำแพงกันดิน', desc: 'พื้นที่: วางกำแพง 1×3 บล็อก บังกระสุนไม่ให้ผ่าน' },
  { id: 'cyclone', emoji: '🌀', name: 'ลมหมุน', desc: 'พื้นที่: วางไซโคลน 2×2 บล็อก กระสุนที่ผ่านจะเปลี่ยนทิศแบบสุ่ม' },
  { id: 'firework', emoji: '🎆', name: 'พลุไฟ', desc: 'พื้นที่: วางพลุ 1×1 บล็อก ถ้ากระสุนโดน ระเบิดฆ่าทุกคนในระยะ 3×3' }
];
const cardById = id => CARDS.find(c => c.id === id) || null;
const AREA_CARD_IDS = new Set(['wall', 'cyclone', 'firework']);
const isAreaCard = id => AREA_CARD_IDS.has(id);
let myCardArea = null; // where I placed my area card this round
let roster = [];        // alive players this round (for the card target picker)
let myCard = null;      // the card I was dealt this round
let myCardTarget = null; // whom I aimed my card at

// mirrors server.js timing constants for the sequential fire animation
const SHOT_START_DELAY = 4200;
const SHOT_INTERVAL = 1300;
const POWER_PAUSE = 1900; // extra gap after a shot that triggers a power/mirror zoom
const BULLET_SPEED = 16; // units/sec — medium travel speed for the bullet ball
// does this shot pull the camera in on a power/mirror? (must match server shotHasZoom)
function shotHasZoom(s) {
  return !!(s.drunken || s.revenge || (s.dodges && s.dodges.length) ||
    (s.manDeflects && s.manDeflects.length) || (s.mirrors && s.mirrors.length));
}

const $ = id => document.getElementById(id);

// ---------- Character picker (lobby) ----------
const charPickerEl = $('charPicker');
CHARACTERS.forEach(c => {
  const btn = document.createElement('button');
  btn.className = 'charBtn';
  btn.textContent = c.name;
  btn.addEventListener('click', () => {
    selfChar = c.id;
    socket.emit('setChar', { char: c.id });
    updateCharPickerUI();
  });
  charPickerEl.appendChild(btn);
});
function updateCharPickerUI() {
  [...charPickerEl.children].forEach((btn, i) => btn.classList.toggle('active', CHARACTERS[i].id === selfChar));
}

const homeScreen = $('homeScreen');
const lobbyScreen = $('lobbyScreen');
const hud = $('hud');
const gameOverPanel = $('gameOverPanel');
const canvas = $('gameCanvas');

// --- home screen tabs ---
$('tabCreate').addEventListener('click', () => setTab('create'));
$('tabJoin').addEventListener('click', () => setTab('join'));
function setTab(which) {
  $('tabCreate').classList.toggle('active', which === 'create');
  $('tabJoin').classList.toggle('active', which === 'join');
  $('createForm').classList.toggle('hidden', which !== 'create');
  $('joinForm').classList.toggle('hidden', which !== 'join');
  $('homeErr').textContent = '';
}

$('btnCreate').addEventListener('click', () => {
  const name = $('nameCreate').value.trim() || 'Player';
  socket.emit('createRoom', { name });
});
$('btnJoin').addEventListener('click', () => {
  const code = $('roomCodeInput').value.trim().toUpperCase();
  const name = $('nameJoin').value.trim() || 'Player';
  if (!code) { $('homeErr').textContent = 'กรอกรหัสห้องก่อนนะ'; return; }
  socket.emit('joinRoom', { code, name });
});
$('btnStart').addEventListener('click', () => socket.emit('startGame'));
$('btnPlayAgain').addEventListener('click', () => socket.emit('playAgain'));
$('btnEndGame').addEventListener('click', () => {
  if (confirm('จบเกมตอนนี้แล้วพาทุกคนกลับไปที่ล็อบบี้?')) socket.emit('endToLobby');
});
$('btnAddBot').addEventListener('click', () => socket.emit('addBot'));

// ---------- Reference guide (collapsible list of all cards + powers) ----------
function buildGuide() {
  const powerOrder = ['matrix', 'drunken', 'revenger', 'man'];
  let html = '<div class="guideHead">🃏 การ์ดพลัง (สุ่มทุกตา)</div>';
  CARDS.forEach(c => {
    html += `<div class="guideItem"><span class="gEmoji">${c.emoji}</span>
      <span><b>${c.name}</b> — ${c.desc}</span></div>`;
  });
  html += '<div class="guideHead">⚡ พลังแฝง (สุ่มตอนเริ่มเกม ซ่อนไว้)</div>';
  powerOrder.forEach(pid => {
    const d = (POWER_DESC[pid] || '').replace(/^[^—]*—\s*/, '');
    html += `<div class="guideItem"><span class="gEmoji">${POWER_EMOJI[pid]}</span>
      <span><b>${POWER_DESC[pid].split(' — ')[0]}</b> — ${d}</span></div>`;
  });
  $('guidePanel').innerHTML = html;
}
// build lazily on first open (CARDS/POWER_DESC are defined further down the file)
let guideBuilt = false;
$('btnGuide').addEventListener('click', () => {
  if (!guideBuilt) { buildGuide(); guideBuilt = true; }
  $('guidePanel').classList.toggle('hidden');
});

socket.on('errorMsg', ({ message }) => {
  $('homeErr').textContent = message;
  $('lobbyErr').textContent = message;
});

socket.on('joined', data => {
  selfId = data.selfId;
  roomCode = data.code;
});

socket.on('roomUpdate', data => {
  roomCode = data.code;
  isHost = data.hostId === selfId;
  if (data.state === 'lobby') {
    revealActive = false;
    spectating = false;
    $('btnEndGame').classList.add('hidden');
    showScreen('lobby');
    $('lobbyCode').textContent = data.code;
    const list = $('lobbyPlayers');
    list.innerHTML = '';
    data.players.forEach(p => {
      if (p.id === selfId) {
        selfChar = p.char || 'buddha'; updateCharPickerUI();
        selfAlive = true;
      }
      const charName = (CHARACTERS.find(c => c.id === p.char) || CHARACTERS[0]).name;
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.innerHTML = `<span class="dot" style="background:${p.color}"></span>
        <span>${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)} <small style="opacity:.6">(${charName})</small>${p.id === data.hostId ? ' 👑' : ''}${p.id === selfId ? ' (คุณ)' : ''}</span>`;
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '10px';
      li.appendChild(label);
      if (p.isBot && isHost) {
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.className = 'removeBotBtn';
        removeBtn.addEventListener('click', () => socket.emit('removeBot', { id: p.id }));
        li.appendChild(removeBtn);
      }
      list.appendChild(li);
    });
    $('btnStart').classList.toggle('hidden', !isHost);
    $('btnStart').disabled = data.players.length < 2;
    $('btnAddBot').classList.toggle('hidden', !isHost || data.players.length >= 10);
  }
});

socket.on('gameOver', ({ winnerId, winnerName }) => {
  showScreen('gameover');
  if (winnerId) {
    $('gameOverTitle').textContent = winnerId === selfId ? '🏆 คุณชนะ!' : `🏆 ${winnerName} ชนะ!`;
    $('gameOverSubtitle').textContent = 'รอดคนเดียวบนเกาะ';
  } else {
    $('gameOverTitle').textContent = '💥 เสมอ ไม่มีผู้รอด';
    $('gameOverSubtitle').textContent = 'ทุกคนยิงโดนกันหมด';
  }
  $('btnPlayAgain').classList.toggle('hidden', !isHost);
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showScreen(name) {
  homeScreen.classList.toggle('hidden', name !== 'home');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  hud.classList.toggle('hidden', name !== 'game');
  gameOverPanel.classList.toggle('hidden', name !== 'gameover');
  canvas.classList.toggle('hidden', name !== 'game');
}

// ---------- Three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;      // softer, nicer shadows
renderer.toneMapping = THREE.ACESFilmicToneMapping;    // cinematic-but-clean tone
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xdce8f2, 48, 140); // soft cloud haze; background set in the scenery setup below

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 260);

const hemi = new THREE.HemisphereLight(0xe4eeff, 0x9a8f7a, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2e0, 1.15);
sun.position.set(10, 20, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -25; sun.shadow.camera.right = 25;
sun.shadow.camera.top = 25; sun.shadow.camera.bottom = -25;
scene.add(sun);

// soft image-based lighting from an HDRI sky (the cartoon gradient stays as the visible background)
// switch the filename to swap moods: table_mountain_1_puresky_2k (bright) / kiara_1_dawn_2k (dawn)
new RGBELoader().load('hdri/kiara_1_dawn_2k.hdr', hdr => {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.8;
  hdr.dispose(); pmrem.dispose();
}, undefined, err => console.warn('[hdri] load failed', err));

let composer = null; // declared early so resize() can reference it safely

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) composer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// gentle bloom for a bright, glowy cartoon feel (falls back to plain render if it fails)
try {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.6, 0.85));
  composer.addPass(new OutputPass());
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(window.innerWidth, window.innerHeight);
} catch (e) { console.warn('[postfx] disabled', e); composer = null; }

// ---------- Sky & sea of clouds (pure scenery — a floating island vibe) ----------
function makeSkyTexture() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#b8d3ef'); g.addColorStop(0.55, '#e7eef7'); g.addColorStop(1, '#f6e7e2');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeCloudTexture() {
  const s = 128; const c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.55, 'rgba(240,246,252,0.55)');
  g.addColorStop(1, 'rgba(240,246,252,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); ctx.fill();
  return new THREE.CanvasTexture(c);
}
scene.background = makeSkyTexture();
(function buildScenery() {
  const g = new THREE.Group();
  // a soft cloud "floor" far below so there's no empty void under the island
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(150, 40),
    new THREE.MeshBasicMaterial({ color: 0xeef4fb, transparent: true, opacity: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2; floor.position.y = -12; g.add(floor);
  // scattered cloud puffs forming a sea of clouds around & below the island
  const cloudTex = makeCloudTexture();
  for (let i = 0; i < 80; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.85, depthWrite: false }));
    const a = Math.random() * Math.PI * 2, rad = 15 + Math.random() * 78;
    sp.position.set(Math.cos(a) * rad, -2.5 - Math.random() * 8, Math.sin(a) * rad);
    const sc = 6 + Math.random() * 11; sp.scale.set(sc, sc * 0.6, 1);
    g.add(sp);
  }
  // distant misty rock peaks poking out of the clouds (Chinese-landscape backdrop)
  const peakMat = new THREE.MeshStandardMaterial({ color: 0xb4c2d3, roughness: 1, flatShading: true, transparent: true, opacity: 0.85 });
  for (let i = 0; i < 13; i++) {
    const a = Math.random() * Math.PI * 2, rad = 55 + Math.random() * 55;
    const h = 9 + Math.random() * 18, r = 3 + Math.random() * 4;
    const p = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), peakMat);
    p.position.set(Math.cos(a) * rad, -7 + h / 2, Math.sin(a) * rad);
    p.rotation.y = Math.random() * Math.PI;
    g.add(p);
  }
  scene.add(g);
})();

// small stylized decorations that cling to the island rim (pure scenery)
function makePineTree(x, z) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 }));
  trunk.position.y = 0.25; g.add(trunk);
  const folMat = new THREE.MeshStandardMaterial({ color: 0x2f7d4f, roughness: 1, flatShading: true });
  for (let k = 0; k < 3; k++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.34 - k * 0.08, 0.42, 7), folMat);
    c.position.y = 0.5 + k * 0.3; c.castShadow = true; g.add(c);
  }
  g.position.set(x, -0.3, z);
  return g;
}
function makePagoda(x, z) {
  const g = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xceb089, roughness: 1 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xb5462f, roughness: 0.8, flatShading: true });
  const w1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), wallMat); w1.position.y = 0.25; g.add(w1);
  const r1 = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.28, 4), roofMat); r1.position.y = 0.62; r1.rotation.y = Math.PI / 4; g.add(r1);
  const w2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), wallMat); w2.position.y = 0.9; g.add(w2);
  const r2 = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.24, 4), roofMat); r2.position.y = 1.15; r2.rotation.y = Math.PI / 4; g.add(r2);
  g.position.set(x, -0.2, z);
  return g;
}

// ---------- Island ----------
let islandGroup = new THREE.Group();
scene.add(islandGroup);

// a point at parameter t (0..1) around the rim of a square of half-size r
function rimPoint(t, r) {
  const p = (t % 1) * 4, side = Math.floor(p), u = ((p - side) * 2 - 1) * r;
  if (side === 0) return [u, -r];
  if (side === 1) return [r, u];
  if (side === 2) return [-u, r];
  return [-r, u];
}

function buildIsland(size) {
  scene.remove(islandGroup);
  islandGroup = new THREE.Group();
  const n = Math.round(size);
  const half = n / 2;
  const topGeo = new THREE.BoxGeometry(1, 1, 1);
  const grassMatA = new THREE.MeshStandardMaterial({ color: 0x5cbf5c, roughness: 0.9 });
  const grassMatB = new THREE.MeshStandardMaterial({ color: 0x4fae4f, roughness: 0.9 });

  // playable grass grid (unchanged — this is the game surface)
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) {
      const x = ix - (n - 1) / 2;
      const z = iz - (n - 1) / 2;
      const mat = ((ix + iz) % 2 === 0) ? grassMatA : grassMatB;
      const block = new THREE.Mesh(topGeo, mat);
      block.position.set(x, -0.5, z);
      block.receiveShadow = true;
      islandGroup.add(block);
    }
  }

  // rocky cliff base underneath — the floating-island look (pure scenery)
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x949aa3, roughness: 1, flatShading: true });
  const H = half * 1.7 + 4;
  const rock = new THREE.Mesh(new THREE.ConeGeometry(half * 1.12, H, 7), rockMat);
  rock.rotation.x = Math.PI;           // apex points down
  rock.rotation.y = Math.random() * Math.PI;
  rock.position.y = -1 - H / 2 + 0.7;  // wide top tucks just under the grass
  rock.castShadow = true;
  islandGroup.add(rock);
  for (let i = 0; i < 3; i++) {         // a few smaller lumps for a rugged silhouette
    const hh = half * (0.8 + Math.random());
    const lump = new THREE.Mesh(new THREE.ConeGeometry(half * (0.35 + Math.random() * 0.3), hh, 6), rockMat);
    lump.rotation.x = Math.PI;
    const a = Math.random() * Math.PI * 2;
    lump.position.set(Math.cos(a) * half * 0.55, -1.5 - hh / 2, Math.sin(a) * half * 0.55);
    islandGroup.add(lump);
  }

  // pine trees + a small pagoda along the square rim (just outside the walkable area)
  const treeCount = Math.max(6, Math.round(n * 0.7));
  for (let i = 0; i < treeCount; i++) {
    const [tx, tz] = rimPoint((i + Math.random() * 0.6) / treeCount, half + 0.15);
    islandGroup.add(makePineTree(tx, tz));
  }
  const [px, pz] = rimPoint(Math.random(), half + 0.25);
  islandGroup.add(makePagoda(px, pz));

  scene.add(islandGroup);
  return n;
}

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// ---------- Player visuals ----------
function addHatDecoration(group, hat) {
  const topY = 0.85 + 0.42; // top of the head cube
  switch (hat) {
    case 'party': {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 16), new THREE.MeshStandardMaterial({ color: 0xff5fa2 }));
      cone.position.y = topY + 0.19;
      const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffe066 }));
      pom.position.y = topY + 0.42;
      group.add(cone, pom);
      break;
    }
    case 'tophat': {
      const black = new THREE.MeshStandardMaterial({ color: 0x222222 });
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.05, 16), black);
      brim.position.y = topY + 0.02;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.32, 16), black);
      top.position.y = topY + 0.2;
      group.add(brim, top);
      break;
    }
    case 'halo': {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 8, 20),
        new THREE.MeshStandardMaterial({ color: 0xfff2a8, emissive: 0xffe066, emissiveIntensity: 0.7 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = topY + 0.22;
      group.add(ring);
      break;
    }
    case 'horns': {
      const mat = new THREE.MeshStandardMaterial({ color: 0xcc2b2b });
      const l = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), mat);
      l.position.set(-0.14, topY + 0.06, 0);
      l.rotation.z = 0.5;
      const r = l.clone();
      r.position.x = 0.14;
      r.rotation.z = -0.5;
      group.add(l, r);
      break;
    }
    case 'bunny': {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.32, 8), mat);
      l.position.set(-0.12, topY + 0.16, 0);
      l.rotation.z = 0.25;
      const r = l.clone();
      r.position.x = 0.12;
      r.rotation.z = -0.25;
      group.add(l, r);
      break;
    }
    case 'crown': {
      const gold = new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: 0.4, roughness: 0.3 });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 8), gold);
      band.position.y = topY + 0.08;
      group.add(band);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), gold);
        spike.position.set(Math.sin(a) * 0.2, topY + 0.22, Math.cos(a) * 0.2);
        group.add(spike);
      }
      break;
    }
    case 'propeller': {
      const capMat = new THREE.MeshStandardMaterial({ color: 0xff9f43 });
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
      cap.position.y = topY;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 6), new THREE.MeshStandardMaterial({ color: 0x888888 }));
      stem.position.y = topY + 0.24;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.03, 0.06), new THREE.MeshStandardMaterial({ color: 0xff5fa2 }));
      blade.position.y = topY + 0.3;
      group.add(cap, stem, blade);
      break;
    }
    case 'chef': {
      const white = new THREE.MeshStandardMaterial({ color: 0xffffff });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 12), white);
      band.position.y = topY + 0.06;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), white);
      puff.position.y = topY + 0.28;
      puff.scale.y = 1.2;
      group.add(band, puff);
      break;
    }
    default:
      break;
  }
}

function addBackDecoration(group, back) {
  const midY = 0.55; // roughly shoulder height on the body
  const backZ = -0.22; // just behind the body
  switch (back) {
    case 'devilwing': {
      const mat = new THREE.MeshStandardMaterial({ color: 0x8b1a1a, roughness: 0.6, side: THREE.DoubleSide });
      const makeWing = sign => {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 4, 1, true), mat);
        wing.scale.set(1, 0.5, 0.35);
        wing.rotation.z = sign * Math.PI / 2.1;
        wing.rotation.y = sign * 0.5;
        wing.position.set(sign * 0.32, midY, backZ);
        return wing;
      };
      group.add(makeWing(-1), makeWing(1));
      break;
    }
    case 'chickenwing': {
      const mat = new THREE.MeshStandardMaterial({ color: 0xf4c968, roughness: 0.8 });
      const makeWing = sign => {
        const wing = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), mat);
        wing.scale.set(0.55, 1, 0.4);
        wing.rotation.z = sign * 0.5;
        wing.position.set(sign * 0.28, midY - 0.05, backZ + 0.02);
        return wing;
      };
      group.add(makeWing(-1), makeWing(1));
      break;
    }
    case 'angelwing': {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide });
      const makeWing = sign => {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.55, 4, 1, true), mat);
        wing.scale.set(1, 0.55, 0.3);
        wing.rotation.z = sign * Math.PI / 2.1;
        wing.rotation.y = sign * 0.4;
        wing.position.set(sign * 0.33, midY + 0.05, backZ);
        return wing;
      };
      group.add(makeWing(-1), makeWing(1));
      break;
    }
    case 'jetpack': {
      const bodyMat2 = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.3, roughness: 0.5 });
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.16), bodyMat2);
      pack.position.set(0, midY, backZ - 0.02);
      const flameMat = new THREE.MeshStandardMaterial({ color: 0xff8c1a, emissive: 0xff5500, emissiveIntensity: 0.8 });
      const makeThruster = sign => {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8), bodyMat2);
        t.position.set(sign * 0.1, midY - 0.28, backZ - 0.02);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 8), flameMat);
        flame.position.set(sign * 0.1, midY - 0.42, backZ - 0.02);
        flame.rotation.x = Math.PI;
        group.add(t, flame);
      };
      group.add(pack);
      makeThruster(-1);
      makeThruster(1);
      break;
    }
    case 'cape': {
      const mat = new THREE.MeshStandardMaterial({ color: 0xd7263d, roughness: 0.7, side: THREE.DoubleSide });
      const cape = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.03), mat);
      cape.position.set(0, midY - 0.1, backZ);
      cape.rotation.x = 0.15;
      group.add(cape);
      break;
    }
    case 'balloon': {
      const colors = [0xff5fa2, 0xffe066, 0x6ec4ff];
      colors.forEach((c, i) => {
        const balloon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), new THREE.MeshStandardMaterial({ color: c }));
        const ox = (i - 1) * 0.14;
        balloon.position.set(ox, midY + 0.55, backZ);
        const stringMat = new THREE.MeshBasicMaterial({ color: 0x999999 });
        const string = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.4, 4), stringMat);
        string.position.set(ox * 0.3, midY + 0.3, backZ);
        string.rotation.z = ox * -0.6;
        group.add(balloon, string);
      });
      break;
    }
    default:
      break;
  }
}

function makePlayerMesh(color, isSelf, char) {
  // use the chosen 3D model once it's loaded; otherwise fall back to the block character
  const tpl = charTemplates[char] || charTemplates[CHARACTERS[0].id];
  const group = tpl ? makeCharMesh(color, tpl) : makeBlockMesh(color);

  if (isSelf) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.6, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
    group.userData.ring = ring;
  }
  return group;
}

// clone the loaded model, auto-fit it to the game's player size, and (if rigged) start its idle loop
function makeCharMesh(color, tpl) {
  const group = new THREE.Group();
  const inner = new THREE.Group();       // holds the model so we can offset/scale it without touching the group
  const model = skeletonClone(tpl.scene);
  model.traverse(o => { if (o.isMesh) o.castShadow = true; });
  inner.add(model);

  // auto scale to MODEL_HEIGHT and drop it so the feet sit on the ground (y=0), centred on x/z
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);
  const s = MODEL_HEIGHT / (size.y || 1);
  model.scale.setScalar(s);
  model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  inner.rotation.y = MODEL_FACE_Y;
  group.add(inner);
  group.userData.model = inner;

  // coloured base ring so each player's colour is easy to read from above
  const base = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.58, 28),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.015;
  group.add(base);

  const idle = clipByName(tpl, 'Idle');
  if (idle) {
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(idle).play();
    charMixers.push({ mixer, mesh: group });
  }
  return group;
}

// original geometric block character (fallback / until a model finishes loading)
function makeBlockMesh(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.4), bodyMat);
  body.position.y = 0.425;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), bodyMat);
  head.position.y = 0.85 + 0.21;
  head.castShadow = true;
  group.add(body, head);

  const nub = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x222222 })
  );
  nub.position.set(0, 0.55, 0.35);
  group.add(nub);
  return group;
}

function makeNameSprite(text, color) {
  const cvs = document.createElement('canvas');
  cvs.width = 256; cvs.height = 64;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = 'rgba(10,16,32,0.75)';
  roundRect(ctx, 0, 8, 256, 48, 14); ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(14, 22, 14, 14);
  ctx.font = 'bold 24px Segoe UI, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 38, 42);
  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLaser(color) {
  const geo = new THREE.CylinderGeometry(0.04, 0.04, 1, 8);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, 0.5); // pivot at base, extend along +z locally
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
  return new THREE.Mesh(geo, mat);
}

// ---------- Muzzle flash / bullet / blood FX ----------
let flareTextureCache = null;
function getFlareTexture() {
  if (flareTextureCache) return flareTextureCache;
  const cvs = document.createElement('canvas');
  cvs.width = 64; cvs.height = 64;
  const ctx = cvs.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,220,120,0.9)');
  grad.addColorStop(1, 'rgba(255,180,60,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  flareTextureCache = new THREE.CanvasTexture(cvs);
  return flareTextureCache;
}

let bloodTextureCache = null;
function getBloodTexture() {
  if (bloodTextureCache) return bloodTextureCache;
  const cvs = document.createElement('canvas');
  cvs.width = 128; cvs.height = 128;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(150,10,10,0.88)';
  for (let i = 0; i < 10; i++) {
    const cx = 64 + (Math.random() - 0.5) * 70;
    const cy = 64 + (Math.random() - 0.5) * 70;
    const r = 8 + Math.random() * 20;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(90,0,0,0.9)';
  ctx.beginPath(); ctx.arc(64, 64, 16, 0, Math.PI * 2); ctx.fill();
  bloodTextureCache = new THREE.CanvasTexture(cvs);
  return bloodTextureCache;
}

let fxSprites = [], fxBeams = [], fxParticles = [], revealDecals = [], fxBullets = [], fxLabels = [];

// hidden-power icons + a short label that floats up above a player when a power fires
const POWER_EMOJI = { matrix: '🕶️', drunken: '🥴', revenger: '👻', man: '💪' };
const POWER_DESC = {
  matrix: 'The Matrix — หลบกระสุนนัดแรกของเกม กระสุนทะลุไปโดนคนข้างหลัง',
  drunken: 'เมาดิบ — 33% ยิงออกด้านหลังแทน',
  revenger: 'จิตพยาบาท — ตายแล้วยิงสุ่ม 3 นัด',
  man: 'แผ่นหลังลูกผู้ชาย — โดนยิงด้านหลังกระเด็นสุ่มทิศ'
};
// card ids and short blurbs for the in-game reference sheet
const CARD_NAMES = CARDS; // reuse; each has {id,emoji,name,desc}
let zoomFocus = null; // { x, z, until } — pulls the reveal camera in on a triggered power
let playerInfo = new Map(); // id -> { name, color }
let revealedPowers = new Map(); // id -> powerId, kept on the left panel until the match ends

// a hidden power just showed itself — remember it for the persistent left panel
function revealPower(id, powerId) {
  if (!powerId || powerId === 'none') return;
  if (revealedPowers.get(id) === powerId) return;
  revealedPowers.set(id, powerId);
  renderPowerLog();
}

function renderPowerLog() {
  const el = $('powerLog');
  if (!el) return;
  if (revealedPowers.size === 0) { el.classList.add('hidden'); return; }
  let html = '<div class="logTitle">⚡ พลังแฝงที่เปิดแล้ว</div>';
  revealedPowers.forEach((pw, id) => {
    const info = playerInfo.get(id) || { name: '?', color: '#888' };
    html += `<div class="logRow"><span class="orderDot" style="background:${info.color}"></span>
      <span class="logName">${escapeHtml(info.name)}</span></div>
      <div class="logDesc">${POWER_EMOJI[pw] || ''} ${POWER_DESC[pw] || ''}</div>`;
  });
  el.innerHTML = html;
  el.classList.remove('hidden');
}

// which cards were played ON each player this round (left panel, reset every round)
function buildCardLog(data) {
  const el = $('cardLog');
  if (!el) return;
  const byTarget = new Map();
  (data.cards || []).forEach(c => {
    if (!byTarget.has(c.targetId)) byTarget.set(c.targetId, []);
    byTarget.get(c.targetId).push(c.card);
  });
  if (byTarget.size === 0) { el.classList.add('hidden'); return; }
  let html = '<div class="logTitle">🃏 การ์ดที่โดนใส่รอบนี้</div>';
  data.players.forEach(p => {
    const list = byTarget.get(p.id);
    if (!list || !list.length) return;
    const emojis = list.map(cid => (cardById(cid) || {}).emoji || '').join(' ');
    html += `<div class="logRow"><span class="orderDot" style="background:${p.color}"></span>
      <span class="logName">${escapeHtml(p.name)}</span>
      <span class="logCards">${emojis}</span></div>`;
  });
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function floatLabel(x, z, y, text, color) {
  const cvs = document.createElement('canvas');
  cvs.width = 512; cvs.height = 96;
  const ctx = cvs.getContext('2d');
  ctx.font = "bold 54px 'Baloo 2', sans-serif";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(text, 256, 48);
  ctx.fillStyle = color || '#ffffff';
  ctx.fillText(text, 256, 48);
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cvs), transparent: true, depthWrite: false, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(4.2, 0.8, 1);
  sp.position.set(x, y, z);
  scene.add(sp);
  fxLabels.push({ sp, life: 0, duration: 2.9, baseY: y });
}

function spawnMuzzleFlash(entry) {
  const dx = Math.sin(entry.angle), dz = Math.cos(entry.angle);
  const mat = new THREE.SpriteMaterial({
    map: getFlareTexture(), transparent: true, opacity: 1,
    depthWrite: false, blending: THREE.AdditiveBlending
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(entry.x + dx * 0.6, 0.55, entry.z + dz * 0.6);
  sprite.scale.set(0.8, 0.8, 0.8);
  scene.add(sprite);
  fxSprites.push({ sprite, life: 0, duration: 0.18 });
}

const THUNDER_RADIUS_C = 1.6; // mirrors server THUNDER_RADIUS

// an additive glow flash (muzzle / lightning / spark), fades and grows
function spawnFlash(x, y, z, baseScale, color, duration) {
  const mat = new THREE.SpriteMaterial({
    map: getFlareTexture(), color: color || 0xffffff, transparent: true, opacity: 1,
    depthWrite: false, blending: THREE.AdditiveBlending
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(x, y, z);
  sprite.scale.setScalar(baseScale);
  scene.add(sprite);
  fxSprites.push({ sprite, life: 0, duration: duration || 0.4, baseScale });
}

// a round bullet that travels along a poly-line path (multiple segments = a bounce),
// killing any victim tagged on a segment endpoint as it passes.
function spawnSegmentBullet(color, segments, radius) {
  if (!segments || !segments.length) return;
  const pts = [new THREE.Vector3(segments[0].x1, 0.55, segments[0].z1)];
  const hitAt = [null], explodeAt = [null];
  segments.forEach(sg => { pts.push(new THREE.Vector3(sg.x2, 0.55, sg.z2)); hitAt.push(sg.hitId || null); explodeAt.push(sg.explode || null); });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const geo = new THREE.SphereGeometry(radius, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.98 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pts[0]);
  scene.add(mesh);
  const glowMat = new THREE.SpriteMaterial({
    map: getFlareTexture(), color, transparent: true, opacity: 0.7,
    depthWrite: false, blending: THREE.AdditiveBlending
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(radius * 4);
  glow.position.copy(pts[0]);
  scene.add(glow);
  fxBullets.push({ mesh, glow, pts, cum, hitAt, explodeAt, total: cum[cum.length - 1], dist: 0, nextIdx: 1 });
}

// The Thunder VFX: bright bolt glow at the caster plus sparks across the kill radius
function spawnLightning(entry) {
  spawnFlash(entry.x, 1.5, entry.z, 2.4, 0xaad4ff, 0.55);
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * THUNDER_RADIUS_C;
    spawnFlash(entry.x + Math.cos(a) * r, 0.4, entry.z + Math.sin(a) * r, 0.6, 0xdff0ff, 0.4);
  }
}

// พลุไฟ blast: big fiery burst + kill everyone in the 3x3 block
function spawnExplosion(ex) {
  spawnFlash(ex.x, 0.8, ex.z, 3.2, 0xffb040, 0.6);
  spawnFlash(ex.x, 1.4, ex.z, 2.2, 0xffe38a, 0.5);
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 1.5;
    spawnFlash(ex.x + Math.cos(a) * r, 0.4, ex.z + Math.sin(a) * r, 0.7, 0xff7a2a, 0.45);
  }
  (ex.victims || []).forEach(id => killVictim(id));
}

// ---------- Area-card obstacles (กำแพงกันดิน / ลมหมุน / พลุไฟ) ----------
let areaMarker = null;      // my own placement ghost during the placement phase
let obstacleMeshes = [];    // reveal-phase obstacle meshes

function areaBox(type, x, z) {
  if (type === 'wall') {
    const longZ = Math.abs(x) >= Math.abs(z);
    return { type, x, z, minX: x - (longZ ? 0.5 : 1.5), maxX: x + (longZ ? 0.5 : 1.5), minZ: z - (longZ ? 1.5 : 0.5), maxZ: z + (longZ ? 1.5 : 0.5) };
  }
  const h = type === 'cyclone' ? 1.0 : 0.5;
  return { type, x, z, minX: x - h, maxX: x + h, minZ: z - h, maxZ: z + h };
}

function makeObstacleMesh(o, ghost) {
  const g = new THREE.Group();
  if (o.type === 'wall') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(o.maxX - o.minX, 1.2, o.maxZ - o.minZ),
      new THREE.MeshStandardMaterial({ color: 0xa5825f, transparent: !!ghost, opacity: ghost ? 0.4 : 1 }));
    box.position.y = 0.6; g.add(box);
  } else if (o.type === 'cyclone') {
    const r = (o.maxX - o.minX) / 2;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r, 1.9, 22, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x6fd0e8, transparent: true, opacity: ghost ? 0.25 : 0.42, side: THREE.DoubleSide }));
    cyl.position.y = 0.95; g.add(cyl);
    g.userData.spin = true;
  } else {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x7a4a2a }));
    stick.position.y = 0.25; g.add(stick);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xffcc33, emissive: 0xaa7711, transparent: !!ghost, opacity: ghost ? 0.5 : 1 }));
    bulb.position.y = 0.62; g.add(bulb);
  }
  g.position.set(o.x, 0, o.z);
  return g;
}

function placeAreaMarker(type, x, z) {
  clearAreaMarker();
  areaMarker = makeObstacleMesh(areaBox(type, x, z), true);
  scene.add(areaMarker);
}
function clearAreaMarker() { if (areaMarker) { scene.remove(areaMarker); areaMarker = null; } }
function clearObstacles() { obstacleMeshes.forEach(m => scene.remove(m)); obstacleMeshes = []; }
function buildObstacles(list) {
  clearObstacles();
  (list || []).forEach(o => { const m = makeObstacleMesh(o, false); scene.add(m); obstacleMeshes.push(m); });
}

function makeBloodDecal() {
  const geo = new THREE.PlaneGeometry(1.1 + Math.random() * 0.7, 1.1 + Math.random() * 0.7);
  const mat = new THREE.MeshBasicMaterial({ map: getBloodTexture(), transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = Math.random() * Math.PI * 2;
  return mesh;
}

function spawnImpact(pos) {
  const count = 14;
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = pos.x; positions[i * 3 + 1] = pos.y; positions[i * 3 + 2] = pos.z;
    const theta = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 2.5;
    velocities.push(new THREE.Vector3(Math.cos(theta) * speed, 2 + Math.random() * 2, Math.sin(theta) * speed));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xdd1e1e, size: 0.15, transparent: true, opacity: 1 });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  fxParticles.push({ points, velocities, life: 0, duration: 0.7 });

  const decal = makeBloodDecal();
  decal.position.set(pos.x, 0.015, pos.z);
  scene.add(decal);
  revealDecals.push(decal);
}

function updateFx(dt) {
  for (let i = fxSprites.length - 1; i >= 0; i--) {
    const f = fxSprites[i];
    f.life += dt;
    const t = f.life / f.duration;
    const base = f.baseScale || 0.8;
    f.sprite.scale.setScalar(base * (1 + t * 1.5));
    f.sprite.material.opacity = Math.max(0, 1 - t);
    if (t >= 1) { scene.remove(f.sprite); fxSprites.splice(i, 1); }
  }
  for (let i = fxBeams.length - 1; i >= 0; i--) {
    const b = fxBeams[i];
    b.life += dt;
    const t = b.life / b.duration;
    b.mesh.material.opacity = Math.max(0, 0.95 * (1 - t));
    if (t >= 1) { scene.remove(b.mesh); fxBeams.splice(i, 1); }
  }
  for (let i = fxBullets.length - 1; i >= 0; i--) {
    const b = fxBullets[i];
    b.dist += BULLET_SPEED * dt;
    // trigger the kill / firework blast at any vertex we've now passed
    while (b.nextIdx < b.pts.length && b.dist >= b.cum[b.nextIdx]) {
      if (b.hitAt[b.nextIdx]) killVictim(b.hitAt[b.nextIdx]);
      if (b.explodeAt[b.nextIdx]) spawnExplosion(b.explodeAt[b.nextIdx]);
      b.nextIdx++;
    }
    if (b.dist >= b.total) { scene.remove(b.mesh); scene.remove(b.glow); fxBullets.splice(i, 1); continue; }
    let seg = 1;
    while (seg < b.cum.length && b.cum[seg] < b.dist) seg++;
    const s0 = b.cum[seg - 1], s1 = b.cum[seg];
    const tt = s1 > s0 ? (b.dist - s0) / (s1 - s0) : 0;
    b.mesh.position.lerpVectors(b.pts[seg - 1], b.pts[seg], tt);
    b.glow.position.copy(b.mesh.position);
  }
  for (let i = fxParticles.length - 1; i >= 0; i--) {
    const p = fxParticles[i];
    p.life += dt;
    const t = p.life / p.duration;
    const posAttr = p.points.geometry.attributes.position;
    for (let j = 0; j < p.velocities.length; j++) {
      const v = p.velocities[j];
      posAttr.array[j * 3] += v.x * dt;
      posAttr.array[j * 3 + 1] += v.y * dt;
      posAttr.array[j * 3 + 2] += v.z * dt;
      v.y -= 9 * dt;
    }
    posAttr.needsUpdate = true;
    p.points.material.opacity = Math.max(0, 1 - t);
    if (t >= 1) { scene.remove(p.points); fxParticles.splice(i, 1); }
  }
  for (let i = fxLabels.length - 1; i >= 0; i--) {
    const l = fxLabels[i];
    l.life += dt;
    const t = l.life / l.duration;
    l.sp.position.y = l.baseY + t * 1.3;
    l.sp.material.opacity = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
    if (t >= 1) { scene.remove(l.sp); fxLabels.splice(i, 1); }
  }
}

// ---------- Placement phase state ----------
let selfMesh = null;
let selfLaser = null;
let selfPos = new THREE.Vector3(0, 0, 0);
let selfAngle = 0;
let bounds = 7;
let mouseNdc = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const keys = { w: false, a: false, s: false, d: false };

// ---------- Spectator state (dead players watch the rest of the match) ----------
let selfAlive = true;
let spectating = false;
let spectatorMeshes = new Map(); // id -> { mesh, x, z, angle, targetX, targetZ, targetAngle }
const spectateCamTarget = new THREE.Vector3(0, 14, 10);

function clearSpectatorMeshes() {
  spectatorMeshes.forEach(s => scene.remove(s.mesh));
  spectatorMeshes.clear();
}

socket.on('spectateSnapshot', data => {
  clearSpectatorMeshes();
  data.players.forEach(p => {
    if (p.id === selfId) return;
    const mesh = makePlayerMesh(p.color, false, p.char);
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.y = p.angle;
    scene.add(mesh);
    spectatorMeshes.set(p.id, { mesh, x: p.x, z: p.z, angle: p.angle, targetX: p.x, targetZ: p.z, targetAngle: p.angle });
  });
});

socket.on('spectateMove', ({ id, x, z, angle }) => {
  const s = spectatorMeshes.get(id);
  if (s) { s.targetX = x; s.targetZ = z; s.targetAngle = angle; }
});

function updateSpectate(dt) {
  if (!spectating) return;
  spectatorMeshes.forEach(s => {
    s.x = THREE.MathUtils.lerp(s.x, s.targetX, Math.min(1, dt * 8));
    s.z = THREE.MathUtils.lerp(s.z, s.targetZ, Math.min(1, dt * 8));
    s.angle = THREE.MathUtils.lerp(s.angle, s.targetAngle, Math.min(1, dt * 8));
    s.mesh.position.set(s.x, 0, s.z);
    s.mesh.rotation.y = s.angle;
  });

  camera.position.lerp(spectateCamTarget, 0.04);
  camera.lookAt(0, 0, 0);

  const remain = Math.max(0, roundEndsAt - Date.now());
  const secs = Math.ceil(remain / 1000);
  const tEl = $('timerValue');
  tEl.textContent = secs;
  tEl.classList.toggle('warn', secs <= 6);
}

window.addEventListener('keydown', e => setKey(e.code, true));
window.addEventListener('keyup', e => setKey(e.code, false));
// use physical key codes so movement works on any keyboard layout (Thai, etc.)
function setKey(code, val) {
  if (code === 'KeyW' || code === 'ArrowUp') keys.w = val;
  if (code === 'KeyS' || code === 'ArrowDown') keys.s = val;
  if (code === 'KeyA' || code === 'ArrowLeft') keys.a = val;
  if (code === 'KeyD' || code === 'ArrowRight') keys.d = val;
}

let selfReady = false;
let readyCount = 0;
let readyTotal = 0;
window.addEventListener('keydown', e => {
  if ((e.code === 'Space' || e.key === ' ') && placing && !spectating) {
    e.preventDefault();
    if (!selfReady) {
      selfReady = true;
      socket.emit('ready');
      updateReadyUI();
    }
  }
});

socket.on('readyUpdate', ({ ready, total }) => {
  readyCount = ready;
  readyTotal = total;
  updateReadyUI();
});

function updateReadyUI() {
  if (!placing || spectating) return;
  const inst = $('instructions');
  if (selfReady) {
    inst.textContent = `✅ พร้อมแล้ว! รอเพื่อน... (${readyCount}/${readyTotal})`;
  } else {
    inst.textContent = `WASD เดิน • เมาส์หมุนทิศเลเซอร์ • กด SPACE ยืนยันพร้อมยิง (${readyCount}/${readyTotal})`;
  }
  if (selfMesh && selfMesh.userData.ring) {
    selfMesh.userData.ring.material.color.set(selfReady ? 0x6dff8a : 0xffffff);
  }
}
window.addEventListener('mousemove', e => {
  mouseNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// click on the field to place an area card (กำแพงกันดิน / ลมหมุน / พลุไฟ)
canvas.addEventListener('click', e => {
  if (!placing || selfReady || spectating || !isAreaCard(myCard)) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) {
    const lim = currentIslandSize / 2 - 0.5;
    const x = Math.max(-lim, Math.min(lim, hit.x));
    const z = Math.max(-lim, Math.min(lim, hit.z));
    myCardArea = { x, z };
    socket.emit('useCardArea', { x, z });
    placeAreaMarker(myCard, x, z);
    updateCardHeader();
  }
});

let selfColor = '#3498db';
let placing = false;
let phase = 'placing'; // 'cardpick' (choose 1 of 3) | 'placing' (walk/aim/use card)

// Phase 1: choose 1 of 3 dealt cards
socket.on('roundStart', data => {
  currentIslandSize = buildIsland(data.islandSize);
  bounds = data.bounds;
  currentRound = data.round;
  $('roundValue').textContent = data.round;
  $('islandValue').textContent = Math.round(data.islandSize);

  clearRevealMeshes();
  clearSpectatorMeshes();
  if (selfMesh) { scene.remove(selfMesh); selfMesh = null; }
  if (selfLaser) { scene.remove(selfLaser); selfLaser = null; }

  phase = 'cardpick';
  placing = false;
  spectating = !selfAlive;
  selfReady = false;
  readyCount = 0;
  readyTotal = 0;
  myCard = null;
  myCardTarget = null;
  myCardArea = null;
  clearAreaMarker();
  clearObstacles();
  roster = data.roster || [];
  roster.forEach(pl => playerInfo.set(pl.id, { name: pl.name, color: pl.color }));
  roundEndsAt = data.endsAt;

  showScreen('game');
  $('btnEndGame').classList.toggle('hidden', !isHost);
  $('banner').classList.add('hidden');
  $('eliminatedList').classList.add('hidden');
  $('orderPanel').classList.add('hidden');
  $('cardLog').classList.add('hidden');
  $('choiceOverlay').classList.add('hidden');
  clearInterval(orderShuffleTimer);
  if (data.round === 1) { revealedPowers.clear(); renderPowerLog(); }

  // neutral overview while choosing
  camera.position.set(0, data.islandSize * 0.7 + 7, data.islandSize * 0.6 + 7);
  camera.lookAt(0, 0, 0);

  if (spectating) {
    $('instructions').textContent = '👻 คุณตกรอบแล้ว รอผู้เล่นที่เหลือเลือกการ์ด...';
  } else {
    $('instructions').textContent = '🃏 เลือกการ์ด 1 ใบจาก 3 ใบ';
  }
});

socket.on('yourChoices', data => {
  if (spectating || phase !== 'cardpick') return;
  buildChoiceOverlay(data.choices || []);
});

socket.on('cardPicked', data => { myCard = data.card; });

function buildChoiceOverlay(choices) {
  const el = $('choiceCards');
  el.innerHTML = '';
  choices.forEach(cid => {
    const c = cardById(cid);
    if (!c) return;
    const div = document.createElement('div');
    div.className = 'choiceCard';
    div.innerHTML = `<div class="ccEmoji">${c.emoji}</div>
      <div class="ccName">${c.name}</div>
      <div class="ccDesc">${c.desc}</div>`;
    div.addEventListener('click', () => {
      if (phase !== 'cardpick') return;
      myCard = cid;
      socket.emit('pickCard', { card: cid });
      [...el.children].forEach(ch => ch.classList.remove('chosen'));
      div.classList.add('chosen');
    });
    el.appendChild(div);
  });
  $('choiceOverlay').classList.remove('hidden');
}

// Phase 2: with the chosen card, walk / aim / aim the card
socket.on('placeStart', data => {
  phase = 'placing';
  placing = true;
  spectating = !selfAlive;
  selfReady = false;
  readyCount = 0;
  readyTotal = 0;
  bounds = data.bounds;
  roundEndsAt = data.endsAt;
  roster = data.roster || roster;
  $('choiceOverlay').classList.add('hidden');
  $('orderPanel').classList.add('hidden');
  clearInterval(orderShuffleTimer);

  if (spectating) {
    spectateCamTarget.set(0, data.islandSize * 0.85 + 6, data.islandSize * 0.6 + 4);
    $('instructions').textContent = '👻 คุณตกรอบแล้ว กำลังดูผู้เล่นที่เหลือหาที่กำบัง...';
  } else {
    $('instructions').textContent = 'WASD เดิน • เมาส์เล็งทิศ • ใช้การ์ดด้านขวา • SPACE ยืนยัน';
    selfPos.set((Math.random() - 0.5) * 1, 0, (Math.random() - 0.5) * 1);
    selfAngle = Math.random() * Math.PI * 2;
    selfMesh = makePlayerMesh(selfColor, true, selfChar);
    scene.add(selfMesh);
    selfLaser = makeLaser(selfColor);
    selfLaser.material.opacity = 0.5;
    scene.add(selfLaser);
    updateReadyUI();
    buildCardPicker();
  }
});

socket.on('yourCard', data => {
  myCard = data.card;
  // rebuild the picker now that we know the card (roster vs. area-placement note)
  if (placing && !spectating) buildCardPicker();
});

socket.on('cardTargetSet', data => {
  myCardTarget = data.targetId;
  refreshPickHighlight();
});

// track color for self via roomUpdate
socket.on('roomUpdate', data => {
  const me = data.players.find(p => p.id === selfId);
  if (me) selfColor = me.color;
  $('aliveValue').textContent = data.players.filter(p => p.alive).length + '/' + data.players.length;
});

let roundEndsAt = 0;
let lastSent = 0;

function updatePlacement(dt) {
  if (!placing || !selfMesh) return;
  if (!selfReady) {
    const speed = 4.2;
    let mx = 0, mz = 0;
    if (keys.w) mz -= 1;
    if (keys.s) mz += 1;
    if (keys.a) mx -= 1;
    if (keys.d) mx += 1;
    if (mx || mz) {
      const len = Math.hypot(mx, mz);
      selfPos.x += (mx / len) * speed * dt;
      selfPos.z += (mz / len) * speed * dt;
      selfPos.x = Math.max(-bounds, Math.min(bounds, selfPos.x));
      selfPos.z = Math.max(-bounds, Math.min(bounds, selfPos.z));
    }

    // aim via mouse -> ground plane
    raycaster.setFromCamera(mouseNdc, camera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, hit)) {
      const dx = hit.x - selfPos.x;
      const dz = hit.z - selfPos.z;
      if (Math.hypot(dx, dz) > 0.05) selfAngle = Math.atan2(dx, dz);
    }

    const now = performance.now();
    if (now - lastSent > 80) {
      lastSent = now;
      socket.emit('move', { x: selfPos.x, z: selfPos.z, angle: selfAngle });
    }
  }

  selfMesh.position.set(selfPos.x, 0, selfPos.z);
  selfMesh.rotation.y = selfAngle;
  selfLaser.position.set(selfPos.x, 0.55, selfPos.z);
  selfLaser.rotation.y = selfAngle;
  selfLaser.scale.z = bounds * 2;

  // camera follow, high-angle chase view
  const camOffset = new THREE.Vector3(0, 11, 7);
  camera.position.set(selfPos.x + camOffset.x, camOffset.y, selfPos.z + camOffset.z);
  camera.lookAt(selfPos.x, 0.4, selfPos.z);

  const remain = Math.max(0, roundEndsAt - Date.now());
  const secs = Math.ceil(remain / 1000);
  const tEl = $('timerValue');
  tEl.textContent = secs;
  tEl.classList.toggle('warn', secs <= 6);
}

// ---------- Reveal phase ----------
let revealMeshes = []; // {mesh, sprite, id, x, z, angle, color, wasHit, hitTime, bloodSpawned}
let revealMeshMap = new Map();
let revealShots = [];
let revealClock = 0;
let revealActive = false;

function clearRevealMeshes() {
  revealMeshes.forEach(r => {
    scene.remove(r.mesh);
    scene.remove(r.sprite);
  });
  revealMeshes = [];
  revealMeshMap = new Map();
  revealShots = [];
  fxSprites.forEach(f => scene.remove(f.sprite)); fxSprites = [];
  fxBeams.forEach(f => scene.remove(f.mesh)); fxBeams = [];
  fxParticles.forEach(f => scene.remove(f.points)); fxParticles = [];
  fxBullets.forEach(f => { scene.remove(f.mesh); scene.remove(f.glow); }); fxBullets = [];
  fxLabels.forEach(l => scene.remove(l.sp)); fxLabels = [];
  revealDecals.forEach(d => scene.remove(d)); revealDecals = [];
  clearObstacles();
  zoomFocus = null;
  revealActive = false;
}

// ---------- Card picker (placement phase) ----------
let cardRowMap = new Map();

function updateCardHeader() {
  const el = $('cardHeader');
  const c = cardById(myCard);
  if (!c) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const hint = isAreaCard(myCard)
    ? (myCardArea ? '✅ วางแล้ว! คลิกที่อื่นเพื่อย้าย' : 'คลิกบนสนามเพื่อวางการ์ด • ไม่วาง = สุ่มจุดให้')
    : 'คลิกชื่อด้านล่างเพื่อเลือกเป้า • ไม่เลือก = สุ่มให้';
  el.innerHTML = `<div class="cardEmoji">${c.emoji}</div>
    <div class="cardName">${c.name}</div>
    <div class="cardDesc">${c.desc}</div>
    <div class="cardHint">${hint}</div>`;
}

function refreshPickHighlight() {
  cardRowMap.forEach((li, id) => {
    const picked = id === myCardTarget;
    li.classList.toggle('picked', picked);
    li.querySelector('.pickMark').textContent = picked ? '🎯' : '';
  });
}

function buildCardPicker() {
  const listEl = $('orderList');
  listEl.innerHTML = '';
  cardRowMap.clear();
  clearInterval(orderShuffleTimer);
  $('orderPanelTitle').textContent = '🃏 การ์ดรอบนี้';
  updateCardHeader();
  // area cards are placed on the field, not on a player — no roster to pick from
  if (isAreaCard(myCard)) {
    const note = document.createElement('li');
    note.className = 'orderRow';
    note.style.justifyContent = 'center';
    note.innerHTML = '<span class="orderName" style="text-align:center">🖱️ คลิกบนสนามเพื่อวางการ์ด</span>';
    listEl.appendChild(note);
    $('orderPanel').classList.remove('hidden');
    return;
  }
  roster.forEach(pl => {
    const li = document.createElement('li');
    li.className = 'orderRow pickRow';
    li.innerHTML = `<span class="orderDot" style="background:${pl.color}"></span>
      <span class="orderName">${escapeHtml(pl.name)}${pl.id === selfId ? ' (คุณ)' : ''}</span>
      <span class="pickMark"></span>`;
    li.addEventListener('click', () => {
      if (!placing || selfReady) return;
      myCardTarget = pl.id;
      socket.emit('useCard', { targetId: pl.id });
      refreshPickHighlight();
    });
    cardRowMap.set(pl.id, li);
    listEl.appendChild(li);
  });
  refreshPickHighlight();
  $('orderPanel').classList.remove('hidden');
}

// ---------- Firing order table ----------
let orderRowMap = new Map();
let orderShuffleTimer = null;

function shuffleIds(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// FLIP: smoothly slide each row from its old position to the new DOM order
function reorderRows(idList) {
  const listEl = $('orderList');
  const firstTops = new Map();
  orderRowMap.forEach((row, id) => firstTops.set(id, row.li.getBoundingClientRect().top));
  idList.forEach(id => { const r = orderRowMap.get(id); if (r) listEl.appendChild(r.li); });
  orderRowMap.forEach((row, id) => {
    const dy = firstTops.get(id) - row.li.getBoundingClientRect().top;
    if (!dy) return;
    row.li.style.transition = 'none';
    row.li.style.transform = `translateY(${dy}px)`;
    row.li.getBoundingClientRect(); // force reflow to lock the inverted start
    row.li.style.transition = 'transform .28s cubic-bezier(.2,.8,.3,1)';
    row.li.style.transform = '';
  });
}

function buildOrderTable(data) {
  const listEl = $('orderList');
  listEl.innerHTML = '';
  orderRowMap.clear();
  clearInterval(orderShuffleTimer);
  $('orderPanelTitle').textContent = '🎲 ลำดับการยิง';
  $('cardHeader').classList.add('hidden');

  const trueOrder = data.shots.map(s => s.shooterId); // firing order = shot order
  data.shots.forEach(s => {
    const shooter = data.players.find(p => p.id === s.shooterId);
    if (!shooter) return;
    const card = cardById(shooter.card);
    const li = document.createElement('li');
    li.className = 'orderRow';
    li.innerHTML = `<span class="orderDot" style="background:${shooter.color}"></span>
      <span class="orderName">${escapeHtml(shooter.name)}</span>
      <span class="orderCard" title="${card ? card.name : ''}">${card ? card.emoji : ''}</span>
      <span class="orderResult"></span>`;
    orderRowMap.set(s.shooterId, { li, resultEl: li.querySelector('.orderResult') });
  });

  // start in a random visible order; the true firing order stays hidden until it settles
  shuffleIds(trueOrder.slice()).forEach(id => listEl.appendChild(orderRowMap.get(id).li));
  $('orderPanel').classList.remove('hidden');

  // shuffle rows around a few times, then lock into the real firing order
  // just before the first shot goes off
  if (trueOrder.length > 1) {
    const stepMs = 300;
    const steps = Math.max(1, Math.floor((SHOT_START_DELAY - 350) / stepMs) - 1);
    let step = 0;
    clearInterval(orderShuffleTimer);
    orderShuffleTimer = setInterval(() => {
      step++;
      if (step >= steps) {
        clearInterval(orderShuffleTimer);
        reorderRows(trueOrder); // settle on the real order
      } else {
        reorderRows(shuffleIds(trueOrder.slice()));
      }
    }, stepMs);
  }
}

function shotResultIcon(shot) {
  if (shot.type === 'skip' || shot.skipped) return '💀';
  const hits = (shot.hitIds || []).length;
  if (shot.type === 'thunder') return shot.jammed ? '⚡🚫' : (hits ? '⚡💥' : '⚡');
  return hits ? (hits > 1 ? '🎯🎯' : '🎯') : '❌';
}

function revealOrderRow(shot) {
  const row = orderRowMap.get(shot.shooterId);
  if (!row) return;
  row.li.classList.add('active');
  setTimeout(() => {
    row.li.classList.remove('active');
    row.li.classList.add('done');
    row.resultEl.textContent = shotResultIcon(shot);
  }, 400);
}

socket.on('roundResult', data => {
  placing = false;
  spectating = false;
  const me = data.players.find(p => p.id === selfId);
  if (me) selfAlive = me.alive;
  if (selfMesh) { scene.remove(selfMesh); selfMesh = null; }
  if (selfLaser) { scene.remove(selfLaser); selfLaser = null; }
  clearRevealMeshes();
  clearSpectatorMeshes();

  $('guidePanel').classList.add('hidden'); // close the guide so it doesn't cover the reveal card log
  data.players.forEach(p => playerInfo.set(p.id, { name: p.name, color: p.color }));
  buildCardLog(data);       // which cards were played on whom this round (left)
  renderPowerLog();         // keep the revealed-powers list up to date (left)
  clearAreaMarker();        // remove my placement ghost; show the real obstacles instead
  buildObstacles(data.obstacles);

  data.players.forEach(p => {
    const size = p.size || 1;
    const mesh = makePlayerMesh(p.color, p.id === selfId, p.char);
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.y = p.angle;
    mesh.scale.setScalar(size);
    scene.add(mesh);
    const sprite = makeNameSprite(p.name + (p.id === selfId ? ' (คุณ)' : ''), p.color);
    sprite.position.set(p.x, 1.7 * size + 0.2, p.z);
    scene.add(sprite);
    const entry = {
      mesh, sprite, id: p.id, x: p.x, z: p.z, angle: p.angle, color: p.color, size,
      wasHit: p.wasHit, dying: false, bloodSpawned: false
    };
    revealMeshes.push(entry);
    revealMeshMap.set(p.id, entry);
  });

  // blood/deaths are now triggered as the travelling bullets (or thunder) actually reach victims
  // each power/mirror zoom adds a pause so the camera returns to normal before the next shot fires
  let acc = SHOT_START_DELAY, pausedTotal = 0;
  revealShots = data.shots.map((s, i) => {
    const fireTime = acc;
    acc += SHOT_INTERVAL + (shotHasZoom(s) ? POWER_PAUSE : 0);
    if (shotHasZoom(s)) pausedTotal += POWER_PAUSE;
    return { ...s, fireTime, triggered: false };
  });

  buildOrderTable(data);

  // camera pulls back to see whole island
  const size = data.islandSize;
  overviewCamTarget.set(0, size * 0.85 + 6, size * 0.6 + 4);

  revealClock = 0;
  revealActive = true;

  const bannerDelay = SHOT_START_DELAY + data.shots.length * SHOT_INTERVAL + pausedTotal + 900;
  setTimeout(() => {
    const names = data.eliminated.map(id => {
      const pl = data.players.find(p => p.id === id);
      return pl ? pl.name : '?';
    });
    const banner = $('banner');
    const elimEl = $('eliminatedList');
    if (names.length) {
      banner.textContent = `💥 ตกรอบ: ${names.join(', ')}`;
    } else {
      banner.textContent = '😮 ไม่มีใครโดนยิงรอบนี้';
    }
    elimEl.textContent = data.survivors.length + ' คนยังรอด';
    banner.classList.remove('hidden');
    elimEl.classList.remove('hidden');
  }, bannerDelay);
});

socket.on('nextRoundCountdown', () => {
  // handled implicitly, next 'roundStart' will fire
});

const overviewCamTarget = new THREE.Vector3(0, 14, 10);
const zoomCamPos = new THREE.Vector3();

function updateReveal(dt) {
  if (!revealActive) return;
  revealClock += dt * 1000;

  // pull the camera in on a player whose hidden power is firing, else the wide overview
  if (zoomFocus && revealClock < zoomFocus.until) {
    zoomCamPos.set(zoomFocus.x, 5.5, zoomFocus.z + 5);
    camera.position.lerp(zoomCamPos, 0.09);
    camera.lookAt(zoomFocus.x, 0.6, zoomFocus.z);
  } else {
    if (zoomFocus) zoomFocus = null;
    camera.position.lerp(overviewCamTarget, 0.04);
    camera.lookAt(0, 0, 0);
  }

  revealShots.forEach(s => {
    if (s.triggered || revealClock < s.fireTime) return;
    s.triggered = true;
    revealOrderRow(s);
    triggerShot(s);
  });

  revealMeshes.forEach(entry => {
    if (entry.dying) {
      entry.mesh.rotation.z = THREE.MathUtils.lerp(entry.mesh.rotation.z, Math.PI / 2, dt * 4);
      entry.mesh.position.y = THREE.MathUtils.lerp(entry.mesh.position.y, -0.4 * entry.size, dt * 4);
    } else if (entry.dodgeUntil && revealClock < entry.dodgeUntil) {
      entry.mesh.rotation.x = THREE.MathUtils.lerp(entry.mesh.rotation.x, -1.1, dt * 8); // Matrix lean-back
    } else if (entry.mesh.rotation.x !== 0) {
      entry.mesh.rotation.x = THREE.MathUtils.lerp(entry.mesh.rotation.x, 0, dt * 6);
    }
  });

  obstacleMeshes.forEach(m => { if (m.userData.spin) m.rotation.y += dt * 4; }); // swirl the cyclones

  updateFx(dt);
}

function focusOn(entry, ms) {
  zoomFocus = { x: entry.x, z: entry.z, until: revealClock + ms };
}

// reveal a triggered hidden power: zoom in + a floating label; also the Mirror card reflect
function handlePowerEvents(s) {
  if (s.drunken) {
    const e = revealMeshMap.get(s.shooterId);
    if (e) { focusOn(e, 2500); floatLabel(e.x, e.z, 2.5 * e.size, POWER_EMOJI.drunken + ' เมาดิบ!', '#ffd36b'); revealPower(s.shooterId, 'drunken'); }
  }
  if (s.revenge) {
    const e = revealMeshMap.get(s.shooterId);
    if (e) { focusOn(e, 2600); floatLabel(e.x, e.z, 2.3, POWER_EMOJI.revenger + ' จิตพยาบาท!', '#c9b3ff'); revealPower(s.shooterId, 'revenger'); }
  }
  (s.dodges || []).forEach(id => {
    const e = revealMeshMap.get(id);
    if (!e) return;
    focusOn(e, 2600);
    e.dodgeUntil = revealClock + 1400;
    floatLabel(e.x, e.z, 2.6 * e.size, POWER_EMOJI.matrix + ' MATRIX!', '#9fe0ff');
    revealPower(id, 'matrix');
  });
  (s.manDeflects || []).forEach(id => {
    const e = revealMeshMap.get(id);
    if (!e) return;
    focusOn(e, 2500);
    floatLabel(e.x, e.z, 2.6 * e.size, POWER_EMOJI.man + ' แผ่นหลังลูกผู้ชาย!', '#ffcf7a');
    revealPower(id, 'man');
  });
  // Mirror card reflect (not a hidden power — shown but not logged in the power panel)
  (s.mirrors || []).forEach(id => {
    const e = revealMeshMap.get(id);
    if (!e) return;
    focusOn(e, 2200);
    floatLabel(e.x, e.z, 2.6 * e.size, '🪞 สะท้อน!', '#bfe9ff');
  });
}

// a victim goes down: spatter blood once and start the fall animation
function killVictim(id) {
  const entry = revealMeshMap.get(id);
  if (!entry || entry.dying) return;
  entry.dying = true;
  if (!entry.bloodSpawned) {
    entry.bloodSpawned = true;
    spawnImpact(new THREE.Vector3(entry.x, 0.5, entry.z));
  }
}

function triggerShot(s) {
  if (s.type === 'skip' || s.skipped) return; // already down before their turn
  const shooterEntry = revealMeshMap.get(s.shooterId);
  if (!shooterEntry) return;

  handlePowerEvents(s);

  if (s.type === 'thunder') {
    if (s.jammed) {
      spawnFlash(shooterEntry.x, 0.7, shooterEntry.z, 0.6, 0xbfe0ff, 0.3); // gun fizzles
    } else {
      spawnLightning(shooterEntry);
      (s.hitIds || []).forEach(id => setTimeout(() => killVictim(id), 220));
    }
    return;
  }

  // normal / forked / bouncing bullets
  spawnMuzzleFlash(shooterEntry);
  const bulletR = 0.12 * Math.min(2.2, Math.max(0.6, shooterEntry.size));
  (s.bullets || []).forEach(b => spawnSegmentBullet(shooterEntry.color, b.segments, bulletR));
}

// ---------- main loop ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  if (phase === 'cardpick') {
    const secs = Math.ceil(Math.max(0, roundEndsAt - Date.now()) / 1000);
    const tEl = $('timerValue');
    tEl.textContent = secs;
    tEl.classList.toggle('warn', secs <= 3);
    $('choiceCountdown').textContent = secs;
  }
  updatePlacement(dt);
  updateSpectate(dt);
  updateReveal(dt);
  // advance character animations; drop mixers whose mesh has left the scene
  for (let i = charMixers.length - 1; i >= 0; i--) {
    if (!charMixers[i].mesh.parent) charMixers.splice(i, 1);
    else charMixers[i].mixer.update(dt);
  }
  if (composer) composer.render();
  else renderer.render(scene, camera);
}
animate();

// initial camera position
camera.position.set(0, 11, 8);
camera.lookAt(0, 0, 0);
buildIsland(16);
