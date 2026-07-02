import * as THREE from 'three';

// ---------- Socket & UI plumbing ----------
const socket = io();
let selfId = null;
let roomCode = null;
let isHost = false;
let currentIslandSize = 16;
let currentRound = 1;

// ---------- Hats ----------
const HATS = [
  { id: 'none', emoji: '🚫' },
  { id: 'party', emoji: '🎉' },
  { id: 'tophat', emoji: '🎩' },
  { id: 'halo', emoji: '😇' },
  { id: 'horns', emoji: '😈' },
  { id: 'bunny', emoji: '🐰' },
  { id: 'crown', emoji: '👑' },
  { id: 'propeller', emoji: '🚁' },
  { id: 'chef', emoji: '👨‍🍳' }
];
let selfHat = 'none';

// mirrors server.js timing constants for the sequential fire animation
const SHOT_START_DELAY = 1800;
const SHOT_INTERVAL = 1300;
const BULLET_TRAVEL_MS = 250;

const $ = id => document.getElementById(id);

const hatPickerEl = $('hatPicker');
HATS.forEach(h => {
  const btn = document.createElement('button');
  btn.className = 'hatBtn';
  btn.textContent = h.emoji;
  btn.title = h.id;
  btn.addEventListener('click', () => socket.emit('setHat', { hat: h.id }));
  hatPickerEl.appendChild(btn);
});
function updateHatPickerUI() {
  [...hatPickerEl.children].forEach((btn, i) => btn.classList.toggle('active', HATS[i].id === selfHat));
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
$('btnAddBot').addEventListener('click', () => socket.emit('addBot'));

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
    showScreen('lobby');
    $('lobbyCode').textContent = data.code;
    const list = $('lobbyPlayers');
    list.innerHTML = '';
    data.players.forEach(p => {
      if (p.id === selfId) { selfHat = p.hat || 'none'; updateHatPickerUI(); }
      const hatEmoji = (HATS.find(h => h.id === p.hat) || HATS[0]).emoji;
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.innerHTML = `<span class="dot" style="background:${p.color}"></span>
        <span>${p.isBot ? '🤖 ' : ''}${p.hat && p.hat !== 'none' ? hatEmoji + ' ' : ''}${escapeHtml(p.name)}${p.id === data.hostId ? ' 👑' : ''}${p.id === selfId ? ' (คุณ)' : ''}</span>`;
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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);
scene.fog = new THREE.Fog(0x0b1220, 25, 60);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);

const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x1a2340, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(10, 20, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -25; sun.shadow.camera.right = 25;
sun.shadow.camera.top = 25; sun.shadow.camera.bottom = -25;
scene.add(sun);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- Island ----------
let islandGroup = new THREE.Group();
scene.add(islandGroup);

function buildIsland(size) {
  scene.remove(islandGroup);
  islandGroup = new THREE.Group();
  const n = Math.round(size);
  const topGeo = new THREE.BoxGeometry(1, 1, 1);
  const grassMatA = new THREE.MeshStandardMaterial({ color: 0x5cbf5c, roughness: 0.9 });
  const grassMatB = new THREE.MeshStandardMaterial({ color: 0x4fae4f, roughness: 0.9 });
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x8a6035, roughness: 1 });

  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) {
      const x = ix - (n - 1) / 2;
      const z = iz - (n - 1) / 2;
      const mat = ((ix + iz) % 2 === 0) ? grassMatA : grassMatB;
      const block = new THREE.Mesh(topGeo, mat);
      block.position.set(x, -0.5, z);
      block.receiveShadow = true;
      block.castShadow = false;
      islandGroup.add(block);
      // underside skirt for a floating-island look at the border
      const isEdge = ix === 0 || iz === 0 || ix === n - 1 || iz === n - 1;
      if (isEdge) {
        for (let d = 1; d <= 2; d++) {
          const skirt = new THREE.Mesh(topGeo, dirtMat);
          skirt.position.set(x, -0.5 - d, z);
          islandGroup.add(skirt);
        }
      }
    }
  }
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

function makePlayerMesh(color, isSelf, hat) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.4), bodyMat);
  body.position.y = 0.425;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), bodyMat);
  head.position.y = 0.85 + 0.21;
  head.castShadow = true;
  group.add(body, head);
  addHatDecoration(group, hat);

  // gun / aim nub on front
  const nub = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x222222 })
  );
  nub.position.set(0, 0.55, 0.35);
  group.add(nub);

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

let fxSprites = [], fxBeams = [], fxParticles = [], revealDecals = [];

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

function spawnBulletBeam(shooterEntry, endPos, color) {
  const start = new THREE.Vector3(shooterEntry.x, 0.55, shooterEntry.z);
  const dx = endPos.x - start.x, dz = endPos.z - start.z;
  const dist = Math.max(0.1, Math.hypot(dx, dz));
  const angle = Math.atan2(dx, dz);
  const beam = makeLaser(color);
  beam.material.transparent = true;
  beam.material.opacity = 0.95;
  beam.material.blending = THREE.AdditiveBlending;
  beam.position.copy(start);
  beam.rotation.y = angle;
  beam.scale.z = dist;
  scene.add(beam);
  fxBeams.push({ mesh: beam, life: 0, duration: 0.45 });
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
    f.sprite.scale.setScalar(0.8 * (1 + t * 1.5));
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

window.addEventListener('keydown', e => setKey(e.key, true));
window.addEventListener('keyup', e => setKey(e.key, false));
function setKey(k, val) {
  const key = k.toLowerCase();
  if (key === 'w' || key === 'arrowup') keys.w = val;
  if (key === 's' || key === 'arrowdown') keys.s = val;
  if (key === 'a' || key === 'arrowleft') keys.a = val;
  if (key === 'd' || key === 'arrowright') keys.d = val;
}

let selfReady = false;
let readyCount = 0;
let readyTotal = 0;
window.addEventListener('keydown', e => {
  if ((e.code === 'Space' || e.key === ' ') && placing) {
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
  if (!placing) return;
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

let selfColor = '#3498db';
let placing = false;

socket.on('roundStart', data => {
  currentIslandSize = buildIsland(data.islandSize);
  bounds = data.bounds;
  currentRound = data.round;
  $('roundValue').textContent = data.round;
  $('islandValue').textContent = Math.round(data.islandSize);

  // clear previous reveal meshes
  clearRevealMeshes();

  // find own color from last roomUpdate players list (fallback)
  selfPos.set((Math.random() - 0.5) * 1, 0, (Math.random() - 0.5) * 1);
  selfAngle = Math.random() * Math.PI * 2;

  if (selfMesh) scene.remove(selfMesh);
  if (selfLaser) scene.remove(selfLaser);
  selfMesh = makePlayerMesh(selfColor, true, selfHat);
  scene.add(selfMesh);
  selfLaser = makeLaser(selfColor);
  selfLaser.material.opacity = 0.5;
  scene.add(selfLaser);

  placing = true;
  selfReady = false;
  readyCount = 0;
  readyTotal = 0;
  showScreen('game');
  $('banner').classList.add('hidden');
  $('eliminatedList').classList.add('hidden');
  roundEndsAt = data.endsAt;
  updateReadyUI();
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

  selfMesh.position.set(selfPos.x, 0, selfPos.z);
  selfMesh.rotation.y = selfAngle;
  selfLaser.position.set(selfPos.x, 0.55, selfPos.z);
  selfLaser.rotation.y = selfAngle;
  selfLaser.scale.z = bounds * 2;

  // camera follow, high-angle chase view
  const camOffset = new THREE.Vector3(0, 11, 7);
  camera.position.set(selfPos.x + camOffset.x, camOffset.y, selfPos.z + camOffset.z);
  camera.lookAt(selfPos.x, 0.4, selfPos.z);

  const now = performance.now();
  if (now - lastSent > 80) {
    lastSent = now;
    socket.emit('move', { x: selfPos.x, z: selfPos.z, angle: selfAngle });
  }

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
  revealDecals.forEach(d => scene.remove(d)); revealDecals = [];
  revealActive = false;
}

socket.on('roundResult', data => {
  placing = false;
  if (selfMesh) { scene.remove(selfMesh); selfMesh = null; }
  if (selfLaser) { scene.remove(selfLaser); selfLaser = null; }
  clearRevealMeshes();

  data.players.forEach(p => {
    const mesh = makePlayerMesh(p.color, p.id === selfId, p.hat);
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.y = p.angle;
    scene.add(mesh);
    const sprite = makeNameSprite(p.name + (p.id === selfId ? ' (คุณ)' : ''), p.color);
    sprite.position.set(p.x, 1.7, p.z);
    scene.add(sprite);
    const entry = {
      mesh, sprite, id: p.id, x: p.x, z: p.z, angle: p.angle, color: p.color,
      wasHit: p.wasHit, hitTime: null, bloodSpawned: false
    };
    revealMeshes.push(entry);
    revealMeshMap.set(p.id, entry);
  });

  revealShots = data.shots.map((s, i) => ({ ...s, fireTime: SHOT_START_DELAY + i * SHOT_INTERVAL, triggered: false }));
  revealShots.forEach(s => {
    if (s.hit && s.targetId) {
      const targetEntry = revealMeshMap.get(s.targetId);
      if (targetEntry) targetEntry.hitTime = s.fireTime + BULLET_TRAVEL_MS;
    }
  });

  // camera pulls back to see whole island
  const size = data.islandSize;
  overviewCamTarget.set(0, size * 0.85 + 6, size * 0.6 + 4);

  revealClock = 0;
  revealActive = true;

  const bannerDelay = SHOT_START_DELAY + data.shots.length * SHOT_INTERVAL + 900;
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

function updateReveal(dt) {
  if (!revealActive) return;
  revealClock += dt * 1000;

  camera.position.lerp(overviewCamTarget, 0.04);
  camera.lookAt(0, 0, 0);

  revealShots.forEach(s => {
    if (s.triggered || revealClock < s.fireTime) return;
    s.triggered = true;
    if (s.skipped) return; // this player was already down before their turn came up
    const shooterEntry = revealMeshMap.get(s.shooterId);
    if (!shooterEntry) return;
    spawnMuzzleFlash(shooterEntry);
    let endPos = null;
    if (s.hit && s.targetId) {
      const targetEntry = revealMeshMap.get(s.targetId);
      if (targetEntry) endPos = new THREE.Vector3(targetEntry.x, 0.55, targetEntry.z);
    }
    if (!endPos) {
      const dx = Math.sin(shooterEntry.angle), dz = Math.cos(shooterEntry.angle);
      endPos = new THREE.Vector3(shooterEntry.x + dx * 20, 0.55, shooterEntry.z + dz * 20);
    }
    spawnBulletBeam(shooterEntry, endPos, shooterEntry.color);
  });

  revealMeshes.forEach(entry => {
    if (entry.wasHit && entry.hitTime != null && revealClock >= entry.hitTime) {
      if (!entry.bloodSpawned) {
        entry.bloodSpawned = true;
        spawnImpact(new THREE.Vector3(entry.x, 0.5, entry.z));
      }
      entry.mesh.rotation.z = THREE.MathUtils.lerp(entry.mesh.rotation.z, Math.PI / 2, dt * 4);
      entry.mesh.position.y = THREE.MathUtils.lerp(entry.mesh.position.y, -0.4, dt * 4);
    }
  });

  updateFx(dt);
}

// ---------- main loop ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  updatePlacement(dt);
  updateReveal(dt);
  renderer.render(scene, camera);
}
animate();

// initial camera position
camera.position.set(0, 11, 8);
camera.lookAt(0, 0, 0);
buildIsland(16);
