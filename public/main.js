import * as THREE from 'three';

// ---------- Socket & UI plumbing ----------
const socket = io();
let selfId = null;
let roomCode = null;
let isHost = false;
let currentIslandSize = 16;
let currentRound = 1;

const $ = id => document.getElementById(id);

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
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.innerHTML = `<span class="dot" style="background:${p.color}"></span>
        <span>${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}${p.id === data.hostId ? ' 👑' : ''}${p.id === selfId ? ' (คุณ)' : ''}</span>`;
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
function makePlayerMesh(color, isSelf) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.4), bodyMat);
  body.position.y = 0.425;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), bodyMat);
  head.position.y = 0.85 + 0.21;
  head.castShadow = true;
  group.add(body, head);

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
  selfMesh = makePlayerMesh(selfColor, true);
  scene.add(selfMesh);
  selfLaser = makeLaser(selfColor);
  selfLaser.material.opacity = 0.5;
  scene.add(selfLaser);

  placing = true;
  showScreen('game');
  $('banner').classList.add('hidden');
  $('eliminatedList').classList.add('hidden');
  roundEndsAt = data.endsAt;
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
  tEl.classList.toggle('warn', secs <= 10);
}

// ---------- Reveal phase ----------
let revealMeshes = []; // {mesh, sprite, laser}
let revealBeams = [];
let revealClock = 0;
let revealActive = false;

function clearRevealMeshes() {
  revealMeshes.forEach(r => {
    scene.remove(r.mesh);
    scene.remove(r.sprite);
  });
  revealMeshes = [];
  revealBeams.forEach(b => scene.remove(b.mesh));
  revealBeams = [];
  revealActive = false;
}

socket.on('roundResult', data => {
  placing = false;
  if (selfMesh) { scene.remove(selfMesh); selfMesh = null; }
  if (selfLaser) { scene.remove(selfLaser); selfLaser = null; }
  clearRevealMeshes();

  data.players.forEach(p => {
    const mesh = makePlayerMesh(p.color, p.id === selfId);
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.y = p.angle;
    scene.add(mesh);
    const sprite = makeNameSprite(p.name + (p.id === selfId ? ' (คุณ)' : ''), p.color);
    sprite.position.set(p.x, 1.7, p.z);
    scene.add(sprite);
    revealMeshes.push({ mesh, sprite, id: p.id, wasHit: p.wasHit, alive: p.alive });

    if (p.shotTargetId) {
      const target = data.players.find(t => t.id === p.shotTargetId);
      const dist = target ? Math.hypot(target.x - p.x, target.z - p.z) : 3;
      const beam = makeLaser(p.color);
      beam.material.opacity = 0;
      beam.position.set(p.x, 0.55, p.z);
      beam.rotation.y = p.angle;
      beam.scale.z = dist;
      scene.add(beam);
      revealBeams.push({ mesh: beam, delay: 400 + Math.random() * 300, fired: false, maxScale: dist });
    }
  });

  // camera pulls back to see whole island
  const size = data.islandSize;
  overviewCamTarget.set(0, size * 0.85 + 6, size * 0.6 + 4);

  revealClock = 0;
  revealActive = true;

  setTimeout(() => {
    const names = data.eliminated.map(id => {
      const pl = data.players.find(p => p.id === id);
      return pl ? pl.name : '?';
    });
    const banner = $('banner');
    const elimEl = $('eliminatedList');
    if (names.length) {
      banner.textContent = `💥 ตกรอบ: ${names.join(', ')}`;
      elimEl.textContent = data.survivors.length + ' คนยังรอด';
    } else {
      banner.textContent = '😮 ไม่มีใครโดนยิงรอบนี้';
      elimEl.textContent = data.survivors.length + ' คนยังรอด';
    }
    banner.classList.remove('hidden');
    elimEl.classList.remove('hidden');
  }, 1400);
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

  revealBeams.forEach(b => {
    if (revealClock >= b.delay) {
      b.fired = true;
      b.mesh.material.opacity = Math.min(0.9, b.mesh.material.opacity + dt * 6);
    }
  });

  revealMeshes.forEach(r => {
    if (r.wasHit && revealClock > 900) {
      r.mesh.rotation.z = THREE.MathUtils.lerp(r.mesh.rotation.z, Math.PI / 2, dt * 4);
      r.mesh.position.y = THREE.MathUtils.lerp(r.mesh.position.y, -0.4, dt * 4);
    }
  });
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
