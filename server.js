const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));

const POWER_PICK_DURATION = 12000; // ms to choose 1 of 3 latent powers (once, at match start)
const CARD_PICK_DURATION = 10000; // ms to choose 1 of 3 dealt cards
const PLACE_DURATION = 20000; // ms to walk, aim & aim the chosen card
const NEXT_ROUND_DELAY = 3000; // pause after reveal before next round starts
const HIT_WIDTH = 0.3; // base perpendicular tolerance of a shot
const MIN_ISLAND_SIZE = 6;
const SHRINK_FACTOR = 0.8;

// ---- Special cards (dealt one per player each round) ----
// self-buff cards (always applied to the caster) + area cards (placed on the ground)
const CARD_IDS = ['gobig', 'gosmall', 'divine', 'bounce', 'thunder', 'mirror', 'wall', 'cyclone', 'firework', 'icecage'];
const AREA_CARDS = new Set(['wall', 'cyclone', 'firework', 'thunder', 'icecage']);
// area cards are dealt a third as often as self-buff cards
const cardWeight = id => (AREA_CARDS.has(id) ? 1 : 3);
// deal 3 distinct cards, weighted so area cards show up less
function dealChoices() {
  const pool = CARD_IDS.slice();
  const out = [];
  for (let i = 0; i < 3 && pool.length; i++) {
    let total = pool.reduce((s, id) => s + cardWeight(id), 0);
    let r = Math.random() * total, idx = 0;
    for (; idx < pool.length - 1; idx++) { r -= cardWeight(pool[idx]); if (r <= 0) break; }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
const DIVINE_ANGLE_A = Math.PI / 6; // 30deg
const DIVINE_ANGLE_B = Math.PI / 3; // 60deg
const THUNDER_STRIKE_HALF = 1.0; // ใครปักตะไคร้: half-size of the 2x2 strike zone
const FIREWORK_KILL = 1.5; // half-size of the 3x3 block explosion
const CYCLONE_TRAVEL = 5; // blocks the storm sweeps forward
const CYCLONE_HALF_WIDTH = 1.0; // perpendicular half-width of the storm's path corridor
const CYCLONE_PULL = 2; // blocks a caught player is dragged along the storm's direction
const ICECAGE_HALF = 2.0; // กรงหิมะ: half-size of the 4x4 freeze zone

// build an obstacle for a bullet-interactive area card at (x,z) — wall is a rotatable
// oriented rectangle (OBB), firework is a small axis-aligned trigger box
function makeObstacle(i, type, x, z, extra = {}) {
  if (type === 'wall') {
    // 1x3 rectangle, free-rotated in 45deg steps by the caster (right-click)
    return { i, type, x, z, rot: extra.rot || 0, halfLen: 1.5, halfWid: 0.5 };
  }
  const h = 0.5; // firework: 1x1 trigger box (the 3x3 kill radius is applied separately on trigger)
  return { i, type, x, z, minX: x - h, maxX: x + h, minZ: z - h, maxZ: z + h };
}
// entry distance where ray (ox,oz)+t(dx,dz) enters an AABB, or null if it misses
function rayAABB(ox, oz, dx, dz, minX, maxX, minZ, maxZ) {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return null; }
  else { let a = (minX - ox) / dx, b = (maxX - ox) / dx; if (a > b) [a, b] = [b, a]; tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return null; }
  else { let a = (minZ - oz) / dz, b = (maxZ - oz) / dz; if (a > b) [a, b] = [b, a]; tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  if (tmax < tmin || tmax < 0) return null;
  return tmin > 0 ? tmin : 0;
}
// ray-vs-rotated-rectangle test: rotate the ray into the rectangle's own (axis-aligned) frame,
// then reuse the AABB slab test above — lets the wall/tree-row card be placed at any angle
function rayOBB(ox, oz, dx, dz, cx, cz, halfLen, halfWid, rot) {
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = (ox - cx) * c - (oz - cz) * s;
  const lz = (ox - cx) * s + (oz - cz) * c;
  const ldx = dx * c - dz * s;
  const ldz = dx * s + dz * c;
  return rayAABB(lx, lz, ldx, ldz, -halfLen, halfLen, -halfWid, halfWid);
}
// size multipliers for Go Big / Go Small (10% chance of the extreme version)
function goBigScale() { return Math.random() < 0.1 ? 3.0 : 1.7; }
function goSmallScale() { return Math.random() < 0.1 ? 0.3 : 0.55; }
// effective perpendicular hit tolerance, widened by a big target / big bullet
function effHitWidth(shooterSize, targetSize) {
  return Math.max(0.05, HIT_WIDTH + (targetSize - 1) * 0.4 + (shooterSize - 1) * 0.15);
}
// distance along a ray (ox,oz)+t(dx,dz) until it leaves the square field of half-size `half`,
// plus which axis it exits through (so a bounce can reflect off that boundary correctly)
function rayExitInfo(ox, oz, dx, dz, half) {
  let t = 40, axis = null;
  if (dx > 1e-6) { const c = (half - ox) / dx; if (c < t) { t = c; axis = 'x'; } }
  else if (dx < -1e-6) { const c = (-half - ox) / dx; if (c < t) { t = c; axis = 'x'; } }
  if (dz > 1e-6) { const c = (half - oz) / dz; if (c < t) { t = c; axis = 'z'; } }
  else if (dz < -1e-6) { const c = (-half - oz) / dz; if (c < t) { t = c; axis = 'z'; } }
  return { t: Math.max(0.1, t), axis };
}
// mirror a direction vector off a surface with unit normal (nx,nz) — angle-of-incidence bounce
function reflect(dx, dz, nx, nz) {
  const dot = dx * nx + dz * nz;
  return { x: dx - 2 * dot * nx, z: dz - 2 * dot * nz };
}

// ---- Latent powers (each player picks one at match start, fixed for the match) ----
const POWER_IDS = ['matrix', 'drunken', 'revenger', 'man'];
// deal 3 distinct powers to choose from
function dealPowerChoices() {
  const pool = POWER_IDS.slice();
  const out = [];
  for (let i = 0; i < 3 && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}
// is a bullet travelling at `bulletAng` striking a player facing `faceAng` from behind?
function hitFromBehind(bulletAng, faceAng) {
  return Math.sin(bulletAng) * Math.sin(faceAng) + Math.cos(bulletAng) * Math.cos(faceAng) > 0.15;
}

const CHAR_IDS = ['buddha', 'jesus', 'kongming', 'buu', 'guanyin', 'khanthi', 'hanuman', 'lekroyal']; // selectable character models
const BOT_CHAR_ID = 'bot'; // reserved model, only ever used for bot players (not player-selectable)

// sequential fire animation timing (mirrored client-side in main.js)
const SHOT_START_DELAY = 4200; // pause (also the firing-order shuffle window) before the first shot
const SHOT_INTERVAL = 1300; // gap between each player's turn to fire
const SHOT_END_PAUSE = 800; // pause after the last shot before advancing
const POWER_PAUSE = 1900; // extra gap after a shot that triggered a power/mirror zoom (let it finish)
// a shot that pulls the camera in on a hidden power (or mirror) — the reveal waits for it
function shotHasZoom(s) {
  return !!(s.drunken || s.revenge || (s.dodges && s.dodges.length) ||
    (s.manDeflects && s.manDeflects.length) || (s.mirrors && s.mirrors.length));
}

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#e67e22', '#1abc9c', '#ff6fa3', '#95a5a6', '#34495e'
];

const BOT_NAMES = [
  'บอทน้อย', 'โรบอทเทา', 'ไซบอร์กเป้', 'ลุงหุ่นยนต์', 'ป๋าเหล็ก',
  'จอมเงียบ', 'สไนเปอร์บอท', 'เจ้าเหล็กกล้า', 'มิสเตอร์บอท', 'น้องกลไก'
];

const MAX_PLAYERS = 10;

/** @type {Map<string, Room>} */
const rooms = new Map();

function publicRoomsSummary() {
  return [...rooms.values()]
    .filter(r => r.state === 'lobby')
    .map(r => {
      const host = r.players.get(r.hostId);
      return {
        code: r.code,
        playerCount: r.realPlayerCount(),
        maxPlayers: MAX_PLAYERS,
        hostName: host ? host.name : '???'
      };
    });
}
function broadcastPublicRooms() {
  io.emit('roomList', { rooms: publicRoomsSummary() });
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function computeIslandSize(playerCount) {
  const base = Math.min(30, Math.max(12, 10 + Math.ceil(playerCount * 1.6)));
  return Math.max(MIN_ISLAND_SIZE, Math.round(base * 0.75));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.state = 'lobby'; // lobby | placing | reveal | ended
    this.players = new Map(); // id -> player
    this.round = 0;
    this.islandSize = 12;
    this.timer = null;
    this.roundEndsAt = 0;
    this.botCounter = 0;
    this.spectatorRoom = `${code}::spectators`;
  }

  joinSpectators(id) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.join(this.spectatorRoom);
  }

  leaveSpectators(id) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.leave(this.spectatorRoom);
  }

  publicPlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, alive: p.alive, isBot: !!p.isBot, char: p.char
    }));
  }

  realPlayerCount() {
    return [...this.players.values()].filter(p => !p.isBot).length;
  }

  addBot() {
    if (this.state !== 'lobby') return;
    if (this.players.size >= MAX_PLAYERS) return;
    const id = `bot-${Date.now()}-${this.botCounter}`;
    const name = BOT_NAMES[this.botCounter % BOT_NAMES.length];
    this.botCounter += 1;
    const color = COLORS[this.players.size % COLORS.length];
    this.players.set(id, {
      id, name, color, x: 0, z: 0, angle: 0,
      alive: true, ready: false, isBot: true,
      char: BOT_CHAR_ID
    });
  }

  removeBot(id) {
    const p = this.players.get(id);
    if (p && p.isBot) this.players.delete(id);
  }

  broadcastReady() {
    const alive = [...this.players.values()].filter(p => p.alive);
    const readyCount = alive.filter(p => p.ready).length;
    io.to(this.code).emit('readyUpdate', { ready: readyCount, total: alive.length });
  }

  setReady(id) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state !== 'placing' || p.ready) return;
    p.ready = true;
    this.broadcastReady();
    const alive = [...this.players.values()].filter(pl => pl.alive);
    if (alive.length > 0 && alive.every(pl => pl.ready)) {
      clearTimeout(this.timer);
      this.resolveRound();
    }
  }

  // Area-card placement. Cyclone is 2-phase: the first call locks the storm's origin;
  // every call after that instead re-aims its travel direction (repeatable pre-ready).
  setCardArea(id, x, z) {
    if (this.state !== 'placing') return;
    const p = this.players.get(id);
    if (!p || !p.alive || p.ready || !AREA_CARDS.has(p.card)) return;
    const lim = this.islandSize / 2 - 0.5;
    const cx = Math.max(-lim, Math.min(lim, x)), cz = Math.max(-lim, Math.min(lim, z));
    if (p.card === 'cyclone' && p.cardArea) {
      p.cardAngle = Math.atan2(cx - p.cardArea.x, cz - p.cardArea.z);
      io.to(id).emit('cardAreaSet', { ...p.cardArea, angle: p.cardAngle });
      return;
    }
    p.cardArea = { x: cx, z: cz };
    io.to(id).emit('cardAreaSet', p.cardArea);
  }

  // ต้นไม้ให้ร่ม (wall card): right-click cycles the placed rectangle's rotation 45deg
  rotateCardArea(id) {
    if (this.state !== 'placing') return;
    const p = this.players.get(id);
    if (!p || !p.alive || p.ready || p.card !== 'wall') return;
    p.wallRot = ((p.wallRot || 0) + Math.PI / 4) % (Math.PI * 2);
    io.to(id).emit('cardRotSet', { rot: p.wallRot });
  }

  decideBotMove(bot, half) {
    const z = bot.activeFrozenZone;
    const minX = z ? Math.max(-half, z.minX) : -half, maxX = z ? Math.min(half, z.maxX) : half;
    const minZ = z ? Math.max(-half, z.minZ) : -half, maxZ = z ? Math.min(half, z.maxZ) : half;
    bot.x = minX + Math.random() * (maxX - minX);
    bot.z = minZ + Math.random() * (maxZ - minZ);
    const towardCenter = Math.atan2(-bot.x, -bot.z);
    if (Math.random() < 0.6) {
      // aim roughly at the middle of the island with some noise, a common human instinct
      bot.angle = towardCenter + (Math.random() - 0.5) * 0.9;
    } else {
      bot.angle = Math.random() * Math.PI * 2;
    }
  }

  broadcastRoom() {
    io.to(this.code).emit('roomUpdate', {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      round: this.round,
      players: this.publicPlayers()
    });
    broadcastPublicRooms();
  }

  aliveIds() {
    return [...this.players.values()].filter(p => p.alive).map(p => p.id);
  }

  startGame() {
    if (this.players.size < 2) return;
    this.round = 0;
    for (const p of this.players.values()) {
      p.alive = true;
      this.leaveSpectators(p.id);
      p.matrixUsed = false; // The Matrix dodge is a once-per-match trigger
      p.kills = 0;          // eliminations caused this match (for the final scoreboard)
      p.eliminatedRound = null; // round they died (null = still alive / winner)
      p.frozenZone = null;       // กรงหิมะ: pending freeze for the player's next placement phase
      p.activeFrozenZone = null; // กรงหิมะ: freeze actively constraining movement this round
      // each player picks one latent power from 3 dealt choices (bots auto-pick)
      p.power = null;
      p.powerChoices = dealPowerChoices();
      if (p.isBot) p.power = p.powerChoices[Math.floor(Math.random() * p.powerChoices.length)];
    }
    this.islandSize = computeIslandSize(this.players.size);
    this.startPowerPick();
  }

  // Match start: each player chooses 1 of 3 latent powers before the first round.
  startPowerPick() {
    this.state = 'powerpick';
    this.roundEndsAt = Date.now() + POWER_PICK_DURATION;
    const roster = [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color }));
    io.to(this.code).emit('powerPickStart', {
      duration: POWER_PICK_DURATION,
      endsAt: this.roundEndsAt,
      islandSize: this.islandSize,
      roster
    });
    for (const p of this.players.values()) {
      if (!p.isBot) io.to(p.id).emit('yourPowers', { choices: p.powerChoices });
    }
    clearTimeout(this.timer);
    this.maybeBeginRounds();
    if (this.state === 'powerpick') this.timer = setTimeout(() => this.beginRounds(), POWER_PICK_DURATION);
  }

  pickPower(id, power) {
    if (this.state !== 'powerpick') return;
    const p = this.players.get(id);
    if (!p || !p.powerChoices || !p.powerChoices.includes(power)) return;
    p.power = power;
    io.to(id).emit('powerPicked', { power });
    this.maybeBeginRounds();
  }

  maybeBeginRounds() {
    const all = [...this.players.values()];
    if (all.length > 0 && all.every(p => p.power)) {
      clearTimeout(this.timer);
      this.beginRounds();
    }
  }

  beginRounds() {
    if (this.state !== 'powerpick') return;
    // auto-assign a random power to anyone who never chose
    for (const p of this.players.values()) {
      if (!p.power) p.power = p.powerChoices[Math.floor(Math.random() * p.powerChoices.length)];
    }
    this.startRound();
  }

  // Phase 1: deal each player 3 random cards to choose 1 from (10s)
  startRound() {
    this.round += 1;
    this.state = 'cardpick';
    const half = this.islandSize / 2 - 0.6;
    const aliveList = [...this.players.values()].filter(p => p.alive);
    for (const p of aliveList) {
      p.ready = false;
      p.shotTargetId = null;
      p.card = null;
      p.cardArea = null;
      p.cardAngle = null;
      p.wallRot = 0;
      // deal 3 distinct cards to choose from (area cards weighted to appear less)
      p.cardChoices = dealChoices();
      // bots choose one of their 3 immediately
      if (p.isBot) p.card = p.cardChoices[Math.floor(Math.random() * p.cardChoices.length)];
    }
    this.roundEndsAt = Date.now() + CARD_PICK_DURATION;
    const roster = aliveList.map(p => ({ id: p.id, name: p.name, color: p.color }));
    io.to(this.code).emit('roundStart', {
      phase: 'cardpick',
      round: this.round,
      islandSize: this.islandSize,
      duration: CARD_PICK_DURATION,
      endsAt: this.roundEndsAt,
      bounds: half,
      roster
    });
    for (const p of aliveList) {
      if (!p.isBot) io.to(p.id).emit('yourChoices', { choices: p.cardChoices });
    }
    clearTimeout(this.timer);
    this.maybeBeginPlacement();
    if (this.state === 'cardpick') this.timer = setTimeout(() => this.beginPlacement(), CARD_PICK_DURATION);
  }

  pickCard(id, card) {
    if (this.state !== 'cardpick') return;
    const p = this.players.get(id);
    if (!p || !p.alive || !p.cardChoices || !p.cardChoices.includes(card)) return;
    p.card = card;
    io.to(id).emit('cardPicked', { card });
    this.maybeBeginPlacement();
  }

  maybeBeginPlacement() {
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length > 0 && alive.every(p => p.card)) {
      clearTimeout(this.timer);
      this.beginPlacement();
    }
  }

  // Phase 2: with the chosen card, walk / aim / aim the card (20s)
  beginPlacement() {
    if (this.state !== 'cardpick') return;
    this.state = 'placing';
    const half = this.islandSize / 2 - 0.6;
    const aliveList = [...this.players.values()].filter(p => p.alive);
    for (const p of aliveList) {
      if (!p.card) p.card = p.cardChoices[Math.floor(Math.random() * p.cardChoices.length)]; // auto-pick if idle
      p.ready = false;
      // กรงหิมะ only constrains the ONE round right after a player gets caught in it
      p.activeFrozenZone = p.frozenZone || null;
      p.frozenZone = null;
      if (p.isBot) {
        this.decideBotMove(p, half);
        p.ready = true;
        if (p.card === 'cyclone') {
          p.cardArea = { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
          p.cardAngle = Math.random() * Math.PI * 2;
        } else if (AREA_CARDS.has(p.card)) {
          p.cardArea = { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
        }
      } else {
        const z = p.activeFrozenZone;
        if (z) {
          p.x = (z.minX + z.maxX) / 2;
          p.z = (z.minZ + z.maxZ) / 2;
        } else {
          p.x = (Math.random() - 0.5) * 1.5;
          p.z = (Math.random() - 0.5) * 1.5;
        }
        p.angle = Math.random() * Math.PI * 2;
      }
    }
    this.roundEndsAt = Date.now() + PLACE_DURATION;
    const roster = aliveList.map(p => ({ id: p.id, name: p.name, color: p.color }));
    io.to(this.code).emit('placeStart', {
      round: this.round,
      islandSize: this.islandSize,
      duration: PLACE_DURATION,
      endsAt: this.roundEndsAt,
      bounds: half,
      roster
    });
    for (const p of aliveList) {
      if (!p.isBot) io.to(p.id).emit('yourCard', { card: p.card, frozenZone: p.activeFrozenZone || null });
    }
    io.to(this.spectatorRoom).emit('spectateSnapshot', {
      round: this.round,
      players: aliveList.map(p => ({
        id: p.id, name: p.name, color: p.color, char: p.char,
        x: p.x, z: p.z, angle: p.angle
      }))
    });
    this.broadcastReady();
    clearTimeout(this.timer);
    if (aliveList.length > 0 && aliveList.every(p => p.ready)) {
      this.timer = setTimeout(() => this.resolveRound(), 400);
    } else {
      this.timer = setTimeout(() => this.resolveRound(), PLACE_DURATION);
    }
  }

  handleMove(id, x, z, angle) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state !== 'placing' || p.ready) return;
    const half = this.islandSize / 2 - 0.6;
    const z0 = p.activeFrozenZone;
    const minX = z0 ? Math.max(-half, z0.minX) : -half, maxX = z0 ? Math.min(half, z0.maxX) : half;
    const minZ = z0 ? Math.max(-half, z0.minZ) : -half, maxZ = z0 ? Math.min(half, z0.maxZ) : half;
    p.x = Math.max(minX, Math.min(maxX, x));
    p.z = Math.max(minZ, Math.min(maxZ, z));
    p.angle = angle;
    io.to(this.spectatorRoom).emit('spectateMove', { id: p.id, x: p.x, z: p.z, angle: p.angle });
  }

  resolveRound() {
    if (this.state !== 'placing') return;
    this.state = 'reveal';
    clearTimeout(this.timer);

    const alive = [...this.players.values()].filter(p => p.alive);
    const aliveMap = new Map(alive.map(p => [p.id, p]));
    const fieldHalf = this.islandSize / 2;
    const areaLim = fieldHalf - 0.5;

    // resolve an area card's placed position, falling back to a random spot if never placed
    const resolveArea = caster => {
      let a = caster.cardArea;
      if (!a) a = { x: (Math.random() * 2 - 1) * areaLim, z: (Math.random() * 2 - 1) * areaLim };
      a = { x: Math.max(-areaLim, Math.min(areaLim, a.x)), z: Math.max(-areaLim, Math.min(areaLim, a.z)) };
      caster.cardArea = a;
      return a;
    };

    // 1. ไซโคลน pre-pass — the storm sweeps BEFORE anything else, since it changes the
    //    real positions combat will use for the rest of the round.
    const cyclones = [];
    for (const caster of alive) {
      if (caster.card !== 'cyclone') continue;
      const origin = resolveArea(caster);
      const angle = caster.cardAngle != null ? caster.cardAngle : Math.random() * Math.PI * 2;
      caster.cardAngle = angle;
      const dx = Math.sin(angle), dz = Math.cos(angle);
      const pulls = [];
      for (const t of alive) {
        const vx = t.x - origin.x, vz = t.z - origin.z;
        const along = vx * dx + vz * dz;
        if (along < 0 || along > CYCLONE_TRAVEL) continue;
        const perp = Math.abs(vx * dz - vz * dx);
        if (perp > CYCLONE_HALF_WIDTH) continue;
        const fromX = t.x, fromZ = t.z;
        const toX = Math.max(-fieldHalf, Math.min(fieldHalf, t.x + dx * CYCLONE_PULL));
        const toZ = Math.max(-fieldHalf, Math.min(fieldHalf, t.z + dz * CYCLONE_PULL));
        t.x = toX; t.z = toZ;
        pulls.push({ id: t.id, fromX, fromZ, toX, toZ });
      }
      cyclones.push({ casterId: caster.id, x: origin.x, z: origin.z, angle, pulls });
    }

    // 2. resolve every other card. Non-area cards always apply to the caster themselves.
    const fx = new Map(); // id -> { size, mirror } (queried by arbitrary id elsewhere, so kept as a map)
    for (const p of alive) fx.set(p.id, { size: 1, mirror: false });
    const cards = []; // every card cast this round (for the reveal card-log panel)
    const obstacles = []; // bullet-interactive area cards (wall / firework)
    const icecages = []; // กรงหิมะ zones (not bullet-interactive — freezes movement instead)
    for (const caster of alive) {
      cards.push({ casterId: caster.id, card: caster.card, targetId: caster.id });
      if (caster.card === 'cyclone') continue; // already resolved in the pre-pass above
      if (caster.card === 'wall' || caster.card === 'firework') {
        const a = resolveArea(caster);
        obstacles.push(makeObstacle(obstacles.length, caster.card, a.x, a.z, { rot: caster.wallRot || 0 }));
        continue;
      }
      if (caster.card === 'icecage') {
        const a = resolveArea(caster);
        const caughtIds = [];
        for (const t of alive) {
          if (Math.abs(t.x - a.x) <= ICECAGE_HALF && Math.abs(t.z - a.z) <= ICECAGE_HALF) {
            t.frozenZone = {
              minX: a.x - ICECAGE_HALF, maxX: a.x + ICECAGE_HALF,
              minZ: a.z - ICECAGE_HALF, maxZ: a.z + ICECAGE_HALF
            };
            caughtIds.push(t.id);
          }
        }
        icecages.push({ casterId: caster.id, x: a.x, z: a.z, caughtIds });
        continue;
      }
      if (caster.card === 'thunder') {
        resolveArea(caster); // strike itself happens on the caster's own firing-order turn
        continue;
      }
      // self-buff cards
      const e = fx.get(caster.id);
      switch (caster.card) {
        case 'gobig': e.size *= goBigScale(); break;
        case 'gosmall': e.size *= goSmallScale(); break;
        case 'mirror': e.mirror = true; break;
        // divine / bounce need no fx flag — checked directly via caster.card when they fire
      }
    }

    const firingOrder = shuffle(alive);
    const stillAlive = new Set(alive.map(p => p.id));
    const shots = [];

    // cast one straight segment. `selfId` is the id the bullet won't hit (its owner); it changes
    // after a Mirror reflection so the shot can fly back into the original shooter.
    // The Matrix lets its owner dodge the first hit of the match (bullet floats past to whoever's
    // behind) — but a Mirror card on that target overrides the dodge (card beats power).
    const castSegment = (ox, oz, ang, shooter, selfId, excludeIds, excludeObs, dodgeOut, maxRange) => {
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const cands = [];
      for (const t of alive) {
        if (t.id === selfId || !stillAlive.has(t.id) || excludeIds.has(t.id)) continue;
        const vx = t.x - ox, vz = t.z - oz;
        const fwd = vx * dx + vz * dz;
        if (fwd <= 0.05) continue;
        const perp = Math.abs(vx * dz - vz * dx);
        if (perp <= effHitWidth(fx.get(shooter.id).size, fx.get(t.id).size)) cands.push({ t, fwd });
      }
      cands.sort((a, b) => a.fwd - b.fwd);
      const exitInfo = rayExitInfo(ox, oz, dx, dz, fieldHalf);
      const exitDist = Math.min(exitInfo.t, maxRange != null ? maxRange : Infinity);
      // nearest area-card obstacle along the ray
      let obs = null, obsT = Infinity;
      for (const o of obstacles) {
        if (excludeObs.has(o.i)) continue;
        const t = o.type === 'wall'
          ? rayOBB(ox, oz, dx, dz, o.x, o.z, o.halfLen, o.halfWid, o.rot)
          : rayAABB(ox, oz, dx, dz, o.minX, o.maxX, o.minZ, o.maxZ);
        if (t != null && t > 0.02 && t < obsT) { obsT = t; obs = o; }
      }
      const obsPoint = () => ({ type: obs.type, obs, x: ox + dx * obsT, z: oz + dz * obsT, exited: false });
      for (const c of cands) {
        if (c.fwd > exitDist) break;
        if (obs && obsT <= c.fwd) return obsPoint(); // obstacle stands between us and this player
        const t = c.t;
        if (t.power === 'matrix' && !t.matrixUsed && !fx.get(t.id).mirror) {
          t.matrixUsed = true;
          dodgeOut.push(t.id);
          continue; // dodged
        }
        return { type: 'player', hitId: t.id, x: t.x, z: t.z, exited: false };
      }
      if (obs && obsT < exitDist) return obsPoint();
      const d = Math.min(exitDist, 40);
      return { type: 'miss', hitId: null, x: ox + dx * d, z: oz + dz * d, exited: exitInfo.t < 40 && exitDist >= exitInfo.t, exitAxis: exitInfo.axis };
    };

    // resolve one bullet (bounces / MAN ricochets / Mirror reflections / area obstacles), collecting kills + events
    const fireBullet = (shooter, a0, bounces, kills, ev, maxRange) => {
      const segments = [];
      const touched = new Set(kills); // never interact with the same player twice on one bullet
      const touchedObs = new Set();
      let ox = shooter.x, oz = shooter.z, ang = a0, bouncesLeft = bounces, selfId = shooter.id;
      for (let step = 0; step < 8; step++) {
        const r = castSegment(ox, oz, ang, shooter, selfId, touched, touchedObs, ev.dodges, maxRange);
        const seg = { x1: ox, z1: oz, x2: r.x, z2: r.z, hitId: null };
        segments.push(seg);
        if (r.type === 'wall') { seg.wall = true; break; } // ต้นไม้ให้ร่ม blocks the shot
        if (r.type === 'firework') { // ปอมเปอี blows up, killing everyone in a 3x3 block
          seg.firework = true; touchedObs.add(r.obs.i);
          const victims = [];
          for (const t of alive) {
            if (!stillAlive.has(t.id)) continue;
            if (Math.abs(t.x - r.obs.x) <= FIREWORK_KILL && Math.abs(t.z - r.obs.z) <= FIREWORK_KILL) {
              victims.push(t.id); kills.add(t.id);
            }
          }
          seg.explode = { x: r.obs.x, z: r.obs.z, victims };
          break;
        }
        if (r.type === 'player') {
          const victim = aliveMap.get(r.hitId);
          // Mirror card: thorn armour bounces the shot straight back at the shooter (card beats power)
          if (fx.get(r.hitId).mirror) {
            seg.mirror = victim.id;
            ev.mirror.push(victim.id);
            touched.add(victim.id);
            ang = Math.atan2(shooter.x - r.x, shooter.z - r.z);
            ox = r.x; oz = r.z; selfId = victim.id;
            continue;
          }
          // The MAN ricochets any shot that strikes his back
          if (victim && victim.power === 'man' && hitFromBehind(ang, victim.angle)) {
            seg.manDeflect = victim.id;
            ev.man.push(victim.id);
            touched.add(victim.id);
            ox = r.x; oz = r.z; ang = Math.random() * Math.PI * 2;
            continue;
          }
          seg.hitId = r.hitId;
          kills.add(r.hitId);
          touched.add(r.hitId);
          // The Bounce: reflect off the victim's own facing direction (angle of incidence)
          if (bouncesLeft > 0) {
            bouncesLeft--;
            const dx0 = Math.sin(ang), dz0 = Math.cos(ang);
            const nx = Math.sin(victim.angle), nz = Math.cos(victim.angle);
            const rf = reflect(dx0, dz0, nx, nz);
            ang = Math.atan2(rf.x, rf.z);
            ox = r.x; oz = r.z;
            continue;
          }
          break;
        }
        // miss / left the field — The Bounce reflects off whichever edge was crossed
        if (r.exited && bouncesLeft > 0) {
          bouncesLeft--;
          const dx0 = Math.sin(ang), dz0 = Math.cos(ang);
          const nx = r.exitAxis === 'x' ? 1 : 0, nz = r.exitAxis === 'z' ? 1 : 0;
          const rf = reflect(dx0, dz0, nx, nz);
          ang = Math.atan2(rf.x, rf.z);
          ox = r.x; oz = r.z;
          continue;
        }
        break;
      }
      return segments;
    };

    for (const shooter of firingOrder) {
      if (!stillAlive.has(shooter.id)) {
        shots.push({ shooterId: shooter.id, type: 'skip', skipped: true, hitIds: [] });
        continue;
      }

      // ใครปักตะไคร้: strikes the caster's chosen area instead of firing a directional shot
      if (shooter.card === 'thunder') {
        const a = shooter.cardArea || { x: shooter.x, z: shooter.z };
        const victims = [];
        for (const t of alive) {
          if (!stillAlive.has(t.id)) continue;
          if (Math.abs(t.x - a.x) <= THUNDER_STRIKE_HALF && Math.abs(t.z - a.z) <= THUNDER_STRIKE_HALF) victims.push(t.id);
        }
        victims.forEach(id => stillAlive.delete(id));
        shots.push({ shooterId: shooter.id, type: 'thunder', jammed: false, x: a.x, z: a.z, hitIds: victims });
        continue;
      }

      // The Drunken: a third of the time the shot fires out the back instead
      let baseAngle = shooter.angle, drunken = false;
      if (shooter.power === 'drunken' && Math.random() < 1 / 3) { baseAngle += Math.PI; drunken = true; }

      const kills = new Set();
      const ev = { dodges: [], man: [], mirror: [] };
      let bullets;
      if (shooter.card === 'divine') {
        // ลูกซองแฉก: 4 simultaneous bullets at +-30/+-60deg, capped to half the field diagonal
        const maxRange = fieldHalf * Math.SQRT2;
        const offsets = [-DIVINE_ANGLE_A, DIVINE_ANGLE_A, -DIVINE_ANGLE_B, DIVINE_ANGLE_B];
        bullets = offsets.map(o => ({ segments: fireBullet(shooter, baseAngle + o, 0, kills, ev, maxRange) }));
      } else {
        const bounces = shooter.card === 'bounce' ? 2 : 0;
        bullets = [{ segments: fireBullet(shooter, baseAngle, bounces, kills, ev) }];
      }
      kills.forEach(id => stillAlive.delete(id));
      shots.push({
        shooterId: shooter.id, type: 'shot', bullets, hitIds: [...kills],
        dodges: ev.dodges, manDeflects: ev.man, mirrors: ev.mirror, drunken
      });
    }

    // The Revenger (จิตพยาบาท): anyone who fell this round fires THREE bullets in random
    // directions as they drop.
    for (const dead of alive.filter(p => !stillAlive.has(p.id))) {
      if (dead.power !== 'revenger') continue;
      const kills = new Set();
      const ev = { dodges: [], man: [], mirror: [] };
      const bullets = [];
      for (let i = 0; i < 3; i++) bullets.push({ segments: fireBullet(dead, Math.random() * Math.PI * 2, 0, kills, ev) });
      kills.forEach(id => stillAlive.delete(id));
      shots.push({
        shooterId: dead.id, type: 'shot', revenge: true, bullets, hitIds: [...kills],
        dodges: ev.dodges, manDeflects: ev.man, mirrors: ev.mirror, drunken: false
      });
    }

    // tally eliminations to each shooter for the final scoreboard
    for (const s of shots) {
      const shooter = this.players.get(s.shooterId);
      if (shooter && s.hitIds) shooter.kills += s.hitIds.length;
    }

    const eliminated = [];
    for (const p of alive) {
      if (!stillAlive.has(p.id)) {
        p.alive = false;
        p.eliminatedRound = this.round;
        eliminated.push(p.id);
        if (!p.isBot) this.joinSpectators(p.id);
      }
    }

    const payload = {
      round: this.round,
      islandSize: this.islandSize,
      players: [...this.players.values()]
        .filter(p => alive.includes(p) || eliminated.includes(p.id))
        .map(p => ({
          id: p.id, name: p.name, color: p.color, char: p.char,
          x: p.x, z: p.z, angle: p.angle,
          alive: p.alive,
          wasHit: eliminated.includes(p.id),
          size: (fx.get(p.id) || {}).size || 1,
          card: p.card
        })),
      shots,
      cards,
      obstacles: obstacles.map(o => o.type === 'wall'
        ? { type: o.type, x: o.x, z: o.z, rot: o.rot, halfLen: o.halfLen, halfWid: o.halfWid }
        : { type: o.type, x: o.x, z: o.z, minX: o.minX, maxX: o.maxX, minZ: o.minZ, maxZ: o.maxZ }),
      cyclones,
      icecages,
      eliminated,
      survivors: this.aliveIds()
    };
    io.to(this.code).emit('roundResult', payload);

    const zoomCount = shots.filter(shotHasZoom).length;
    const revealDuration = SHOT_START_DELAY + shots.length * SHOT_INTERVAL + SHOT_END_PAUSE + zoomCount * POWER_PAUSE;
    this.timer = setTimeout(() => this.afterReveal(), revealDuration);
  }

  afterReveal() {
    const survivors = this.aliveIds();
    if (survivors.length <= 1) {
      this.state = 'ended';
      const winner = survivors[0] ? this.players.get(survivors[0]) : null;
      io.to(this.code).emit('gameOver', {
        winner: winner ? { id: winner.id, name: winner.name, char: winner.char, color: winner.color } : null,
        standings: this.buildStandings(winner)
      });
      return;
    }
    this.islandSize = Math.max(MIN_ISLAND_SIZE, Math.round(this.islandSize * SHRINK_FACTOR));
    this.timer = setTimeout(() => this.startRound(), NEXT_ROUND_DELAY);
    io.to(this.code).emit('nextRoundCountdown', { delay: NEXT_ROUND_DELAY, islandSize: this.islandSize });
  }

  // final scoreboard: winner first, then latest-eliminated first (rank by survival),
  // ties broken by kills. Each row carries what the end screen renders.
  buildStandings(winner) {
    const survivalRank = p => (p === winner ? Infinity : (p.eliminatedRound || 0));
    const ranked = [...this.players.values()].sort((a, b) => {
      const d = survivalRank(b) - survivalRank(a);
      return d !== 0 ? d : (b.kills || 0) - (a.kills || 0);
    });
    return ranked.map((p, i) => ({
      rank: i + 1,
      id: p.id, name: p.name, char: p.char, color: p.color, isBot: !!p.isBot,
      kills: p.kills || 0,
      roundReached: p === winner ? this.round : (p.eliminatedRound || this.round),
      isWinner: p === winner
    }));
  }

  resetToLobby() {
    clearTimeout(this.timer);
    this.state = 'lobby';
    this.round = 0;
    for (const p of this.players.values()) {
      p.alive = true;
      this.leaveSpectators(p.id);
    }
    this.broadcastRoom();
  }
}

io.on('connection', socket => {
  let currentRoomCode = null;
  socket.emit('roomList', { rooms: publicRoomsSummary() });

  socket.on('createRoom', ({ name }) => {
    const code = genCode();
    const room = new Room(code, socket.id);
    rooms.set(code, room);
    joinRoomInternal(room, name);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      socket.emit('errorMsg', { message: 'ไม่พบห้องนี้' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('errorMsg', { message: 'เกมเริ่มไปแล้ว รอรอบหน้าหรือสร้างห้องใหม่' });
      return;
    }
    joinRoomInternal(room, name);
  });

  function joinRoomInternal(room, name) {
    currentRoomCode = room.code;
    socket.join(room.code);
    const color = COLORS[room.players.size % COLORS.length];
    room.players.set(socket.id, {
      id: socket.id,
      name: (name || 'Player').slice(0, 16),
      color,
      x: 0, z: 0, angle: 0,
      alive: true,
      ready: false,
      char: 'buddha'
    });
    socket.emit('joined', { code: room.code, selfId: socket.id });
    room.broadcastRoom();
  }

  socket.on('startGame', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    if (room.players.size < 2) return;
    room.startGame();
    room.broadcastRoom();
  });

  socket.on('addBot', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    room.addBot();
    room.broadcastRoom();
  });

  socket.on('setChar', ({ char }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p || !CHAR_IDS.includes(char)) return;
    p.char = char;
    room.broadcastRoom();
  });

  socket.on('removeBot', ({ id }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    room.removeBot(id);
    room.broadcastRoom();
  });

  socket.on('move', ({ x, z, angle }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.handleMove(socket.id, x, z, angle);
  });

  socket.on('ready', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.setReady(socket.id);
  });

  socket.on('pickPower', ({ power }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.pickPower(socket.id, power);
  });

  socket.on('pickCard', ({ card }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.pickCard(socket.id, card);
  });

  socket.on('useCardArea', ({ x, z }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.setCardArea(socket.id, x, z);
  });

  socket.on('rotateCardArea', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.rotateCardArea(socket.id);
  });

  socket.on('playAgain', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;
    room.resetToLobby();
  });

  socket.on('endToLobby', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.state === 'lobby') return;
    room.resetToLobby();
  });

  socket.on('disconnect', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.realPlayerCount() === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      broadcastPublicRooms();
      return;
    }
    if (room.hostId === socket.id) {
      const nextHost = [...room.players.values()].find(p => !p.isBot);
      room.hostId = nextHost ? nextHost.id : null;
    }
    room.broadcastRoom();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Duel Island running at http://localhost:${PORT}`);
});
