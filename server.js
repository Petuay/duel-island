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

const POWER_PICK_DURATION = 15000; // ms to choose 1 of 2 latent powers (once, at match start)
const CARD_PICK_DURATION = 15000; // ms to choose 1 of 3 dealt cards
const PLACE_DURATION = 20000; // ms to walk, aim & aim the chosen card
const NEXT_ROUND_DELAY = 3000; // pause after reveal before next round starts
const HIT_WIDTH = 0.3; // base perpendicular tolerance of a shot
const MIN_ISLAND_SIZE = 2;
// area cards need real placement room — once the island has shrunk down to the minimum,
// stop dealing them entirely (self-buff cards only)
const TINY_ISLAND_SIZE = MIN_ISLAND_SIZE;
const SHRINK_FACTOR = 0.8;

// ---- Special cards (dealt one per player each round) ----
// self-buff cards (always applied to the caster) + area cards (placed on the ground)
// NOTE: 'wall' (ต้นไม้ให้ร่ม) is temporarily pulled from the deal pool below — kept in
// AREA_CARDS/obstacle code intact for a future rework, just not dealt for now.
const CARD_IDS = ['gobig', 'gosmall', 'divine', 'bounce', 'thunder', 'mirror', 'cyclone', 'firework', 'icecage',
  'ghost', 'scapegoat', 'static', 'kneebrace', 'lightningrod'];
const AREA_CARDS = new Set(['wall', 'cyclone', 'firework', 'thunder', 'icecage', 'lightningrod']);
// area-card share starts at 30% (full-size map) and shrinks toward 12% as the island shrinks
// toward MIN_ISLAND_SIZE — less room to place them, so they should show up less.
const AREA_SHARE_MAX = 0.30;
const AREA_SHARE_MIN = 0.07;
// max times a single area card id may appear among all players' dealt choices in one round
const AREA_CARD_ROUND_CAP = 2;
const areaCardCount = CARD_IDS.filter(id => AREA_CARDS.has(id)).length;
const selfCardCount = CARD_IDS.length - areaCardCount;
const cardWeight = (id, areaShare) => (AREA_CARDS.has(id)
  ? areaShare / areaCardCount
  : (1 - areaShare) / selfCardCount);
// rule-of-three interpolation: islandSize going from initialSize down to MIN_ISLAND_SIZE
// maps linearly onto areaShare going from AREA_SHARE_MAX down to AREA_SHARE_MIN.
function areaShareFor(initialSize, currentSize) {
  if (initialSize <= MIN_ISLAND_SIZE) return AREA_SHARE_MIN;
  const frac = Math.min(1, Math.max(0, (initialSize - currentSize) / (initialSize - MIN_ISLAND_SIZE)));
  return AREA_SHARE_MAX - frac * (AREA_SHARE_MAX - AREA_SHARE_MIN);
}
// deal 3 distinct cards, weighted so area cards show up less. `excludeArea` is used for a
// นักสะสม holder already sitting on a banked area card, to guarantee only one is ever active.
// `areaCounts` is a plain object shared across every player's deal this round, used to cap
// any single area card id to AREA_CARD_ROUND_CAP appearances across the whole round.
function dealChoices(excludeArea, areaShare, areaCounts) {
  const pool = (excludeArea ? CARD_IDS.filter(id => !AREA_CARDS.has(id)) : CARD_IDS.slice())
    .filter(id => !AREA_CARDS.has(id) || (areaCounts[id] || 0) < AREA_CARD_ROUND_CAP);
  const out = [];
  for (let i = 0; i < 3 && pool.length; i++) {
    let total = pool.reduce((s, id) => s + cardWeight(id, areaShare), 0);
    let r = Math.random() * total, idx = 0;
    for (; idx < pool.length - 1; idx++) { r -= cardWeight(pool[idx], areaShare); if (r <= 0) break; }
    const picked = pool.splice(idx, 1)[0];
    out.push(picked);
    if (AREA_CARDS.has(picked)) areaCounts[picked] = (areaCounts[picked] || 0) + 1;
  }
  return out;
}
// นักสะสม: which card the placement UI/hitbox this round actually belongs to — the banked
// one if it's an area card (dealing already guarantees the fresh pick isn't, in that case).
function effectiveAreaCard(p) {
  return (p.bankedCard && AREA_CARDS.has(p.bankedCard)) ? p.bankedCard : p.card;
}
const DIVINE_ANGLE_A = Math.PI / 6; // 30deg
const DIVINE_ANGLE_B = Math.PI / 3; // 60deg
const THUNDER_STRIKE_HALF = 1.0; // ใครปักตะไคร้: half-size of the 2x2 strike zone
const FIREWORK_KILL = 1.5; // half-size of the 3x3 block explosion
const CYCLONE_TRAVEL = 5; // blocks the storm sweeps forward
const CYCLONE_HALF_WIDTH = 1.0; // perpendicular half-width of the storm's path corridor
const CYCLONE_PULL = 2; // blocks a caught player is dragged along the storm's direction
const ICECAGE_HALF = 1.5; // กรงหิมะ: half-size of the 3x3 freeze zone
const STATIC_HALF = 1.5; // ไฟฟ้าสถิต: half-size of the 3x3 self-centred blast (replaces the shot)
const ROD_HALF = 2; // สายล่อฟ้า: half-size of the 4x4 influence box around a placed rod
const ROD_STEP = 0.4; // สายล่อฟ้า: bullets are sub-stepped this far at a time while rods are in play
const ROD_MAX_BEND = 0.18; // สายล่อฟ้า: max radians a bullet's heading nudges per step at point-blank range

// build an obstacle for a bullet-interactive area card at (x,z) — wall is a rotatable
// oriented rectangle (OBB), firework is a small axis-aligned trigger box
function makeObstacle(i, type, x, z, extra = {}) {
  if (type === 'wall') {
    // 1x3 rectangle, free-rotated in 45deg steps by the caster (right-click)
    return { i, type, x, z, rot: extra.rot || 0, halfLen: 1.5, halfWid: 0.5 };
  }
  const h = 0.25; // firework: model+trigger box halved (0.5) to make it harder to hit; 3x3 kill radius on trigger is unchanged
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
const POWER_IDS = ['matrix', 'drunken', 'revenger', 'man', 'clairvoyant', 'collector',
  'chainshare', 'gambler', 'standalone'];
// deal 3 distinct powers to choose from
function dealPowerChoices() {
  const pool = POWER_IDS.slice();
  const out = [];
  for (let i = 0; i < 2 && pool.length; i++) {
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
const CYCLONE_INTRO_DURATION_C = 1500; // mirrors client CYCLONE_INTRO_DURATION
const SCAPEGOAT_PAUSE = 2600; // reveal freeze while the ตัวตายตัวแทน swap UI + warp plays (mirrors client)
// extra buffer since the client now waits for the camera to settle AND for a shot's bullets
// to fully finish travelling before the next one fires — both can add real time beyond the
// naive per-shot formula below, especially on a large island with slow-travelling bullets
const CAMERA_SETTLE_SLACK = 5500; // bumped when bullet speed dropped 30% (bullets travel longer now)
// a shot that pulls the camera in — only The Matrix still does now — the reveal waits for it
function shotHasZoom(s) {
  return !!(s.dodges && s.dodges.length);
}
// ตัวตายตัวแทน freezes the reveal to show its swap UI — needs a bigger pause than a normal zoom
function shotHasScapegoat(s) { return !!(s.scapegoat && s.scapegoat.length); }

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
      char: BOT_CHAR_ID, totalScore: 0
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
    const areaCard = p && effectiveAreaCard(p);
    if (!p || !p.alive || p.ready || !AREA_CARDS.has(areaCard)) return;
    const lim = this.islandSize / 2 - 0.5;
    const cx = Math.max(-lim, Math.min(lim, x)), cz = Math.max(-lim, Math.min(lim, z));
    if (areaCard === 'cyclone' && p.cardArea) {
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
    if (!p || !p.alive || p.ready || effectiveAreaCard(p) !== 'wall') return;
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
      p.eyeTargetId = null;      // เนตรทิพย์: whichever alive opponent is being watched this round
      p.bankedCard = null;       // นักสะสม: a card held over from a previous round, if any
      p.cardBanked = false;      // นักสะสม: true if this round's card is being banked instead of used
      // each player picks one latent power from 2 dealt choices (bots auto-pick)
      p.power = null;
      p.powerChoices = dealPowerChoices();
      if (p.isBot) p.power = p.powerChoices[Math.floor(Math.random() * p.powerChoices.length)];
    }
    this.islandSize = computeIslandSize(this.players.size);
    this.initialIslandSize = this.islandSize;
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
    const areaShare = areaShareFor(this.initialIslandSize, this.islandSize);
    const areaCounts = {};
    for (const p of aliveList) {
      p.ready = false;
      p.shotTargetId = null;
      p.card = null;
      p.cardBanked = false;
      p.scapeUsed = false; // ตัวตายตัวแทน / ไม้พยุงเข่า are per-round: reset their one-time triggers
      p.kneeUsed = false;
      // นักสะสม holding a banked area card only gets self-buff choices this round, so at most
      // one area card is ever active between the banked one and the fresh one — and its
      // placement (position/rotation) is preserved across the round instead of being wiped,
      // since this round's placement UI is driven by that banked card, not the fresh pick.
      const excludeArea = this.islandSize <= TINY_ISLAND_SIZE ||
        (p.power === 'collector' && p.bankedCard && AREA_CARDS.has(p.bankedCard));
      if (!excludeArea) { p.cardArea = null; p.cardAngle = null; p.wallRot = 0; }
      p.cardChoices = dealChoices(excludeArea, areaShare, areaCounts);
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
      if (!p.isBot) io.to(p.id).emit('yourChoices', { choices: p.cardChoices, bankedCard: p.bankedCard || null });
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
    p.cardBanked = false; // picking again after a bank decision un-banks this round's choice
    io.to(id).emit('cardPicked', { card });
    this.maybeBeginPlacement();
  }

  // นักสะสม: bank the card just picked instead of using it this round — it carries into next
  // round alongside whatever gets dealt then. Only one card can be held in the bank at a time.
  // นักสะสม: bank the card during placement (before readying up) instead of using it this
  // round — it carries into next round alongside whatever gets dealt then.
  bankCard(id) {
    if (this.state !== 'placing') return;
    const p = this.players.get(id);
    if (!p || !p.alive || p.ready || p.power !== 'collector' || p.bankedCard || !p.card) return;
    p.cardBanked = true;
    io.to(id).emit('cardBanked', { card: p.card });
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
        const areaCard = effectiveAreaCard(p);
        if (areaCard === 'cyclone') {
          p.cardArea = { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
          p.cardAngle = Math.random() * Math.PI * 2;
        } else if (AREA_CARDS.has(areaCard)) {
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
    // เนตรทิพย์: assign a random other alive target each round, then relay their live position privately
    for (const viewer of aliveList) {
      if (viewer.power !== 'clairvoyant') { viewer.eyeTargetId = null; continue; }
      const others = aliveList.filter(p => p.id !== viewer.id);
      viewer.eyeTargetId = others.length ? others[Math.floor(Math.random() * others.length)].id : null;
      if (viewer.eyeTargetId && !viewer.isBot) {
        const target = this.players.get(viewer.eyeTargetId);
        io.to(viewer.id).emit('eyeFootprint', { x: target.x, z: target.z });
      }
    }

    this.roundEndsAt = Date.now() + PLACE_DURATION;
    const roster = aliveList.map(p => ({ id: p.id, name: p.name, color: p.color }));
    // กรงหิมะ: let EVERYONE see whose movement is pinned this round, not just the frozen player
    const frozenPlayers = aliveList
      .filter(p => p.activeFrozenZone)
      .map(p => ({ id: p.id, zone: p.activeFrozenZone }));
    io.to(this.code).emit('placeStart', {
      round: this.round,
      islandSize: this.islandSize,
      duration: PLACE_DURATION,
      endsAt: this.roundEndsAt,
      bounds: half,
      roster,
      frozenPlayers
    });
    for (const p of aliveList) {
      if (!p.isBot) io.to(p.id).emit('yourCard', { card: p.card, bankedCard: p.bankedCard || null, cardBanked: !!p.cardBanked, frozenZone: p.activeFrozenZone || null });
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
    // เนตรทิพย์: relay this player's live position to anyone watching them this round
    for (const viewer of this.players.values()) {
      if (viewer.alive && viewer.eyeTargetId === id) io.to(viewer.id).emit('eyeFootprint', { x: p.x, z: p.z });
    }
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

    // นักสะสม: which card(s) actually apply this round. Banking-this-round means no effect at
    // all (it just gets saved); otherwise it's the fresh pick plus any card banked earlier.
    const activeCardsOf = caster => {
      if (caster.cardBanked) return [];
      return caster.bankedCard ? [caster.card, caster.bankedCard] : [caster.card];
    };
    // for shot-shape cards (divine/bounce/thunder), the fresh pick wins if both active cards
    // would define one — dealing already guarantees at most one active card is ever area-type
    const effectiveShotCard = caster => {
      const shapeCards = ['divine', 'bounce', 'thunder', 'ghost', 'static'];
      if (shapeCards.includes(caster.card)) return caster.card;
      if (caster.bankedCard && shapeCards.includes(caster.bankedCard)) return caster.bankedCard;
      return caster.card;
    };

    // ยืนหนึ่ง (standalone): immune to every AREA effect — only a direct bullet can kill them.
    // Each time an area effect would have caught a standalone player we log it so the client can
    // pop the "ยืนหนึ่ง" label instead of applying the effect.
    const standaloneBlocks = []; // { id, x, z }
    const isStandalone = p => p.power === 'standalone';
    const noteStandalone = t => standaloneBlocks.push({ id: t.id, x: t.x, z: t.z });
    const cycloneDrowned = new Set(); // ไซโคลน: players swept clean off the map's edge — counts as a kill

    // 1. ไซโคลน pre-pass — the storm sweeps BEFORE anything else, since it changes the
    //    real positions combat will use for the rest of the round.
    const cyclones = [];
    for (const caster of alive) {
      if (!activeCardsOf(caster).includes('cyclone')) continue;
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
        if (isStandalone(t)) { noteStandalone(t); continue; } // ยืนหนึ่ง shrugs off the storm
        const fromX = t.x, fromZ = t.z;
        const rawX = t.x + dx * CYCLONE_PULL, rawZ = t.z + dz * CYCLONE_PULL;
        // if the storm would drag them clean off the island's edge, that's a kill — don't clamp
        // back onto the field, let them fly past it (visually) and mark them drowned
        const drowned = rawX < -fieldHalf || rawX > fieldHalf || rawZ < -fieldHalf || rawZ > fieldHalf;
        t.x = rawX; t.z = rawZ;
        if (drowned) cycloneDrowned.add(t.id);
        pulls.push({ id: t.id, fromX, fromZ, toX: rawX, toZ: rawZ, drowned });
      }
      cyclones.push({ casterId: caster.id, x: origin.x, z: origin.z, angle, pulls });
    }

    // 2. resolve every other card. Non-area cards always apply to the caster themselves.
    const fx = new Map(); // id -> { size, mirror } (queried by arbitrary id elsewhere, so kept as a map)
    for (const p of alive) fx.set(p.id, { size: 1, mirror: false });
    const cards = []; // every card cast this round (for the reveal card-log panel)
    const obstacles = []; // bullet-interactive area cards (wall / firework)
    const icecages = []; // กรงหิมะ zones (not bullet-interactive — freezes movement instead)
    const lightningRods = []; // สายล่อฟ้า: poles that bend nearby bullets, not a hard obstacle
    for (const caster of alive) {
      if (caster.cardBanked) {
        // นักสะสม: this round's pick is saved for later — no effect, no placement, no card-log entry
        caster.bankedCard = caster.card;
        continue;
      }
      for (const cardId of activeCardsOf(caster)) {
        cards.push({ casterId: caster.id, card: cardId, targetId: caster.id });
        if (cardId === 'cyclone') continue; // already resolved in the pre-pass above
        if (cardId === 'wall' || cardId === 'firework') {
          const a = resolveArea(caster);
          obstacles.push(makeObstacle(obstacles.length, cardId, a.x, a.z, { rot: caster.wallRot || 0 }));
          continue;
        }
        if (cardId === 'icecage') {
          const a = resolveArea(caster);
          const caughtIds = [];
          for (const t of alive) {
            if (Math.abs(t.x - a.x) <= ICECAGE_HALF && Math.abs(t.z - a.z) <= ICECAGE_HALF) {
              if (isStandalone(t)) { noteStandalone(t); continue; } // ยืนหนึ่ง ไม่โดนแช่แข็ง
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
        if (cardId === 'thunder') {
          resolveArea(caster); // strike itself happens on the caster's own firing-order turn
          continue;
        }
        if (cardId === 'lightningrod') {
          const a = resolveArea(caster);
          lightningRods.push({ casterId: caster.id, x: a.x, z: a.z });
          continue;
        }
        // self-buff cards
        const e = fx.get(caster.id);
        switch (cardId) {
          case 'gobig': e.size *= goBigScale(); break;
          case 'gosmall': e.size *= goSmallScale(); break;
          case 'mirror': e.mirror = true; break;
          // divine / bounce need no fx flag — checked directly via effectiveShotCard when they fire
        }
      }
      if (caster.bankedCard) caster.bankedCard = null; // consumed — one-time use
    }

    const firingOrder = shuffle(alive);
    const stillAlive = new Set(alive.map(p => p.id));
    cycloneDrowned.forEach(id => stillAlive.delete(id)); // swept off the map = dead before anyone even fires
    const shots = [];

    // cast one straight segment. `selfId` is the id the bullet won't hit (its owner); it changes
    // after a Mirror reflection so the shot can fly back into the original shooter.
    // The Matrix lets its owner dodge the first hit of the match (bullet floats past to whoever's
    // behind) — but a Mirror card on that target overrides the dodge (card beats power).
    const castSegment = (ox, oz, ang, shooter, selfId, excludeIds, excludeObs, dodgeOut, maxRange, bypass) => {
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
        // นักพนัน bypass (30%) blows straight through The Matrix's dodge as well
        if (!bypass && t.power === 'matrix' && !t.matrixUsed && !fx.get(t.id).mirror) {
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

    const activeCardsIncludes = (p, id) => !p.cardBanked && (p.card === id || p.bankedCard === id);

    // สายล่อฟ้า: nudge a heading toward any placed rod whose 4x4 box the point sits in — closer
    // means a stronger pull. No-op (returns ang unchanged) whenever no rod is on the field.
    const bendAngle = (x, z, ang) => {
      if (!lightningRods.length) return ang;
      let px = 0, pz = 0;
      for (const rod of lightningRods) {
        const dx = rod.x - x, dz = rod.z - z;
        if (Math.abs(dx) > ROD_HALF || Math.abs(dz) > ROD_HALF) continue;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.05) continue;
        const closeness = 1 - Math.min(1, dist / (ROD_HALF * Math.SQRT2));
        const strength = ROD_MAX_BEND * closeness;
        px += (dx / dist) * strength;
        pz += (dz / dist) * strength;
      }
      if (px === 0 && pz === 0) return ang;
      const dx2 = Math.sin(ang) + px, dz2 = Math.cos(ang) + pz;
      const len = Math.hypot(dx2, dz2) || 1;
      return Math.atan2(dx2 / len, dz2 / len);
    };

    // like castSegment, but when a lightning rod is on the field the leg is walked in small
    // sub-steps (bending the heading each step) instead of one straight cast — produces a
    // curving polyline of micro-segments. Zero extra cost/behavior change when no rod is out.
    const castBentPath = (ox, oz, ang, shooter, selfId, excludeIds, excludeObs, dodgeOut, maxRange, bypass) => {
      if (!lightningRods.length) {
        const r = castSegment(ox, oz, ang, shooter, selfId, excludeIds, excludeObs, dodgeOut, maxRange, bypass);
        return { r, path: [{ x: ox, z: oz }, { x: r.x, z: r.z }], finalAngle: ang };
      }
      let x = ox, z = oz, curAng = ang, travelled = 0;
      const path = [{ x, z }];
      const capRange = maxRange != null ? maxRange : 60;
      for (let i = 0; i < 400 && travelled < capRange; i++) {
        curAng = bendAngle(x, z, curAng);
        const stepLen = Math.min(ROD_STEP, capRange - travelled);
        const r = castSegment(x, z, curAng, shooter, selfId, excludeIds, excludeObs, dodgeOut, stepLen, bypass);
        if (r.type !== 'miss' || r.exited) {
          path.push({ x: r.x, z: r.z });
          return { r, path, finalAngle: curAng };
        }
        x = r.x; z = r.z;
        travelled += stepLen;
        path.push({ x, z });
      }
      return { r: { type: 'miss', hitId: null, x, z, exited: false }, path, finalAngle: curAng };
    };

    // resolve one bullet (bounces / MAN ricochets / Mirror reflections / area obstacles), collecting kills + events.
    // `bypass` (นักพนัน) makes the shot ignore the victim's protective card/power entirely.
    const fireBullet = (shooter, a0, bounces, kills, ev, maxRange, bypass) => {
      const segments = [];
      const touched = new Set(kills); // never interact with the same player twice on one bullet
      const touchedObs = new Set();
      let ox = shooter.x, oz = shooter.z, ang = a0, bouncesLeft = bounces, selfId = shooter.id;
      for (let step = 0; step < 8; step++) {
        const { r, path, finalAngle } = castBentPath(ox, oz, ang, shooter, selfId, touched, touchedObs, ev.dodges, maxRange, bypass);
        for (let k = 0; k < path.length - 1; k++) {
          segments.push({ x1: path[k].x, z1: path[k].z, x2: path[k + 1].x, z2: path[k + 1].z, hitId: null });
        }
        const seg = segments[segments.length - 1];
        ang = finalAngle; // สายล่อฟ้า: bounce/ricochet physics below reflects off the bent incoming angle
        if (r.type === 'wall') { seg.wall = true; break; } // ต้นไม้ให้ร่ม blocks the shot
        if (r.type === 'firework') { // ปอมเปอี blows up, killing everyone in a 3x3 block
          seg.firework = true; touchedObs.add(r.obs.i);
          const victims = [];
          for (const t of alive) {
            if (!stillAlive.has(t.id)) continue;
            if (Math.abs(t.x - r.obs.x) <= FIREWORK_KILL && Math.abs(t.z - r.obs.z) <= FIREWORK_KILL) {
              if (isStandalone(t)) { noteStandalone(t); continue; } // ยืนหนึ่ง ไม่ตายจากระเบิด
              victims.push(t.id); kills.add(t.id);
            }
          }
          seg.explode = { x: r.obs.x, z: r.obs.z, victims };
          break;
        }
        if (r.type === 'player') {
          const victim = aliveMap.get(r.hitId);
          // ตัวตายตัวแทน: about to be hit → swap places with a random player (may be the shooter,
          // or even itself for laughs). Whoever ends up standing here takes the shot instead.
          if (!bypass && victim && activeCardsIncludes(victim, 'scapegoat') && !victim.scapeUsed) {
            victim.scapeUsed = true;
            const pool = alive.filter(p => stillAlive.has(p.id)); // includes shooter + the victim
            const other = pool[Math.floor(Math.random() * pool.length)];
            const sx = victim.x, sz = victim.z;
            victim.x = other.x; victim.z = other.z;
            other.x = sx; other.z = sz;
            seg.scapegoat = { id: victim.id, otherId: other.id };
            ev.scapegoat.push({ id: victim.id, otherId: other.id });
            // the bullet still lands at (r.x,r.z) = the scapegoat's OLD spot; `other` is there now
            seg.hitId = other.id;
            kills.add(other.id);
            touched.add(other.id);
            break;
          }
          // ไม้พยุงเข่า: takes the hit but survives — the bullet stops, and they can't move next round
          if (!bypass && victim && activeCardsIncludes(victim, 'kneebrace') && !victim.kneeUsed) {
            victim.kneeUsed = true;
            victim.nextImmobile = true;
            seg.graze = victim.id;
            ev.knee.push(victim.id);
            touched.add(victim.id);
            break;
          }
          // Mirror card: thorn armour bounces the shot back the way it came (reverses the incoming
          // heading) rather than homing in on wherever the shooter currently stands
          if (!bypass && fx.get(r.hitId).mirror) {
            seg.mirror = victim.id;
            ev.mirror.push(victim.id);
            touched.add(victim.id);
            ang = ang + Math.PI;
            ox = r.x; oz = r.z; selfId = victim.id;
            continue;
          }
          // The MAN ricochets any shot that strikes his back
          if (!bypass && victim && victim.power === 'man' && hitFromBehind(ang, victim.angle)) {
            seg.manDeflect = victim.id;
            ev.man.push(victim.id);
            touched.add(victim.id);
            // reflects by angle of incidence off the victim's own facing, same physics as the bounce card
            const rf = reflect(Math.sin(ang), Math.cos(ang), Math.sin(victim.angle), Math.cos(victim.angle));
            ang = Math.atan2(rf.x, rf.z);
            ox = r.x; oz = r.z;
            continue;
          }
          // นักพนัน flourish: mark the kill if a defense was actually steamrolled by the bypass
          if (bypass && victim && (
            (victim.power === 'matrix' && !victim.matrixUsed) || fx.get(victim.id).mirror ||
            (victim.power === 'man' && hitFromBehind(ang, victim.angle)) ||
            activeCardsIncludes(victim, 'scapegoat') || activeCardsIncludes(victim, 'kneebrace')
          )) ev.gambler.push(victim.id);
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

    // กระสุนผี: a single straight bullet that phases through EVERYTHING — obstacles and players
    // alike — killing every non-dodging player in a line before flying off the field edge.
    const fireGhost = (shooter, a0, kills, ev, bypass) => {
      const dx = Math.sin(a0), dz = Math.cos(a0);
      const exitDist = rayExitInfo(shooter.x, shooter.z, dx, dz, fieldHalf).t;
      const cands = [];
      for (const t of alive) {
        if (t.id === shooter.id || !stillAlive.has(t.id)) continue;
        const vx = t.x - shooter.x, vz = t.z - shooter.z;
        const fwd = vx * dx + vz * dz;
        if (fwd <= 0.05 || fwd > exitDist) continue;
        const perp = Math.abs(vx * dz - vz * dx);
        if (perp <= effHitWidth(fx.get(shooter.id).size, fx.get(t.id).size)) cands.push({ t, fwd });
      }
      cands.sort((a, b) => a.fwd - b.fwd);
      const segments = [];
      let ox = shooter.x, oz = shooter.z;
      for (const c of cands) {
        const t = c.t;
        if (!bypass && t.power === 'matrix' && !t.matrixUsed && !fx.get(t.id).mirror) {
          t.matrixUsed = true; ev.dodges.push(t.id); continue; // even a ghost bullet gets dodged
        }
        segments.push({ x1: ox, z1: oz, x2: t.x, z2: t.z, hitId: t.id });
        kills.add(t.id);
        ox = t.x; oz = t.z;
      }
      segments.push({ x1: ox, z1: oz, x2: shooter.x + dx * exitDist, z2: shooter.z + dz * exitDist, hitId: null, ghost: true });
      return segments;
    };

    const newEv = () => ({ dodges: [], man: [], mirror: [], scapegoat: [], knee: [], gambler: [] });

    for (const shooter of firingOrder) {
      if (!stillAlive.has(shooter.id)) {
        shots.push({ shooterId: shooter.id, type: 'skip', skipped: true, hitIds: [] });
        continue;
      }

      const shotCard = effectiveShotCard(shooter);

      // ใครปักตะไคร้: strikes the caster's chosen area instead of firing a directional shot
      if (shotCard === 'thunder') {
        const a = shooter.cardArea || { x: shooter.x, z: shooter.z };
        const victims = [];
        for (const t of alive) {
          if (!stillAlive.has(t.id) || t.id === shooter.id) continue; // never strikes its own caster
          if (Math.abs(t.x - a.x) <= THUNDER_STRIKE_HALF && Math.abs(t.z - a.z) <= THUNDER_STRIKE_HALF) victims.push(t.id);
        }
        victims.forEach(id => stillAlive.delete(id));
        shots.push({ shooterId: shooter.id, type: 'thunder', jammed: false, x: a.x, z: a.z, hitIds: victims });
        continue;
      }

      // ไฟฟ้าสถิต: no directional shot at all — a blast around the caster kills everyone nearby
      // (ยืนหนึ่ง is immune, like every other area effect)
      if (shotCard === 'static') {
        const victims = [];
        for (const t of alive) {
          if (!stillAlive.has(t.id) || t.id === shooter.id) continue;
          if (Math.abs(t.x - shooter.x) <= STATIC_HALF && Math.abs(t.z - shooter.z) <= STATIC_HALF) {
            if (isStandalone(t)) { noteStandalone(t); continue; }
            victims.push(t.id);
          }
        }
        victims.forEach(id => stillAlive.delete(id));
        shots.push({ shooterId: shooter.id, type: 'static', x: shooter.x, z: shooter.z, hitIds: victims });
        continue;
      }

      // The Drunken: 25% of the time fires ลูกซองแฉก's 4-bullet spread instead of the normal shot
      const baseAngle = shooter.angle;
      const drunken = shooter.power === 'drunken' && Math.random() < 0.25;
      // นักพนัน: 30% of this shot ignores the victim's protective card/power entirely
      const bypass = shooter.power === 'gambler' && Math.random() < 0.5;

      const kills = new Set();
      const ev = newEv();
      let bullets;
      if (shotCard === 'ghost') {
        // กระสุนผี: one piercing bullet through everything (bounce/spread don't apply)
        bullets = [{ segments: fireGhost(shooter, baseAngle, kills, ev, bypass) }];
      } else if (drunken || shotCard === 'divine') {
        // ลูกซองแฉก: 4 simultaneous bullets at +-30/+-60deg, capped to half the field diagonal
        const maxRange = fieldHalf * Math.SQRT2;
        const offsets = [-DIVINE_ANGLE_A, DIVINE_ANGLE_A, -DIVINE_ANGLE_B, DIVINE_ANGLE_B];
        bullets = offsets.map(o => ({ segments: fireBullet(shooter, baseAngle + o, 0, kills, ev, maxRange, bypass) }));
      } else {
        const bounces = shotCard === 'bounce' ? 2 : 0;
        bullets = [{ segments: fireBullet(shooter, baseAngle, bounces, kills, ev, undefined, bypass) }];
      }
      kills.forEach(id => stillAlive.delete(id));
      shots.push({
        shooterId: shooter.id, type: 'shot', bullets, hitIds: [...kills],
        dodges: ev.dodges, manDeflects: ev.man, mirrors: ev.mirror,
        scapegoat: ev.scapegoat, graze: ev.knee, gambler: bypass && ev.gambler.length ? ev.gambler : [],
        drunken
      });
    }

    // แชร์ลูกโซ่ (chainshare): whenever a chainshare holder's bullet kills someone, a ลูกซองแฉก
    // 4-bullet spread erupts from each fresh corpse. Snapshot the shots first so we only react to
    // the primary volley (not to chainshare's own follow-up kills).
    const chainKilled = new Set();
    for (const s of shots.slice()) {
      const shooter = this.players.get(s.shooterId);
      if (!shooter || shooter.power !== 'chainshare' || !s.hitIds || !s.hitIds.length) continue;
      for (const victimId of s.hitIds) {
        if (chainKilled.has(victimId)) continue;
        chainKilled.add(victimId);
        const corpse = aliveMap.get(victimId);
        if (!corpse) continue;
        const kills = new Set();
        const ev = newEv();
        const maxRange = fieldHalf * Math.SQRT2;
        const offsets = [-DIVINE_ANGLE_A, DIVINE_ANGLE_A, -DIVINE_ANGLE_B, DIVINE_ANGLE_B];
        const bullets = offsets.map(o => ({ segments: fireBullet(corpse, o, 0, kills, ev, maxRange) }));
        kills.forEach(id => stillAlive.delete(id));
        shots.push({
          shooterId: victimId, type: 'shot', chainshare: true, sourceId: shooter.id, bullets, hitIds: [...kills],
          dodges: ev.dodges, manDeflects: ev.man, mirrors: ev.mirror,
          scapegoat: ev.scapegoat, graze: ev.knee, gambler: [], drunken: false
        });
      }
    }

    // The Revenger (จิตพยาบาท): anyone who fell this round fires THREE bullets in random
    // directions as they drop.
    for (const dead of alive.filter(p => !stillAlive.has(p.id))) {
      if (dead.power !== 'revenger') continue;
      const kills = new Set();
      const ev = newEv();
      const bullets = [];
      for (let i = 0; i < 3; i++) bullets.push({ segments: fireBullet(dead, Math.random() * Math.PI * 2, 0, kills, ev) });
      kills.forEach(id => stillAlive.delete(id));
      shots.push({
        shooterId: dead.id, type: 'shot', revenge: true, bullets, hitIds: [...kills],
        dodges: ev.dodges, manDeflects: ev.man, mirrors: ev.mirror,
        scapegoat: ev.scapegoat, graze: ev.knee, gambler: [], drunken: false
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
    // ไม้พยุงเข่า: survivors who ate a hit this round are pinned in place next round — reuse the
    // กรงหิมะ frozen-zone plumbing by clamping them to a near-zero box at their current spot.
    for (const p of alive) {
      if (p.alive && p.nextImmobile) {
        p.frozenZone = { minX: p.x - 0.01, maxX: p.x + 0.01, minZ: p.z - 0.01, maxZ: p.z + 0.01, knee: true };
        p.nextImmobile = false;
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
      lightningRods,
      standaloneBlocks,
      eliminated,
      survivors: this.aliveIds()
    };
    io.to(this.code).emit('roundResult', payload);

    const zoomCount = shots.filter(shotHasZoom).length;
    const scapegoatCount = shots.filter(shotHasScapegoat).length;
    const cycloneIntro = cyclones.length ? CYCLONE_INTRO_DURATION_C : 0;
    // CAMERA_SETTLE_SLACK: the client now waits for its reveal camera to actually finish
    // panning back to normal before each next effect fires, which can add a little real
    // time beyond this formula — pad the server's timeout so it never cuts the reveal short.
    const revealDuration = SHOT_START_DELAY + cycloneIntro + shots.length * SHOT_INTERVAL
      + SHOT_END_PAUSE + zoomCount * POWER_PAUSE + scapegoatCount * SCAPEGOAT_PAUSE + CAMERA_SETTLE_SLACK;
    this.timer = setTimeout(() => this.afterReveal(), revealDuration);
  }

  afterReveal() {
    const survivors = this.aliveIds();
    if (survivors.length <= 1) {
      this.state = 'ended';
      this.matchesPlayed = (this.matchesPlayed || 0) + 1;
      const winner = survivors[0] ? this.players.get(survivors[0]) : null;
      io.to(this.code).emit('gameOver', {
        winner: winner ? { id: winner.id, name: winner.name, char: winner.char, color: winner.color } : null,
        standings: this.buildStandings(winner),
        matchesPlayed: this.matchesPlayed
      });
      return;
    }
    this.islandSize = Math.max(MIN_ISLAND_SIZE, Math.round(this.islandSize * SHRINK_FACTOR));
    this.timer = setTimeout(() => this.startRound(), NEXT_ROUND_DELAY);
    io.to(this.code).emit('nextRoundCountdown', { delay: NEXT_ROUND_DELAY, islandSize: this.islandSize });
  }

  // final scoreboard: winner first, then latest-eliminated first (rank by survival),
  // ties broken by kills. Each row carries what the end screen renders. Also tallies
  // cumulative room score (placement points + kills), so it keeps building up across
  // repeated matches in the same room ("เล่นในห้องเดิมต่อเนื่อง") until the room closes.
  buildStandings(winner) {
    const survivalRank = p => (p === winner ? Infinity : (p.eliminatedRound || 0));
    const ranked = [...this.players.values()].sort((a, b) => {
      const d = survivalRank(b) - survivalRank(a);
      return d !== 0 ? d : (b.kills || 0) - (a.kills || 0);
    });
    return ranked.map((p, i) => {
      const kills = p.kills || 0;
      const placementPoints = Math.max(0, ranked.length - i - 1);
      p.totalScore = (p.totalScore || 0) + placementPoints + kills;
      return {
        rank: i + 1,
        id: p.id, name: p.name, char: p.char, color: p.color, isBot: !!p.isBot,
        kills, roundReached: p === winner ? this.round : (p.eliminatedRound || this.round),
        isWinner: p === winner,
        matchScore: placementPoints + kills, totalScore: p.totalScore
      };
    });
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
      char: 'buddha',
      totalScore: 0
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

  socket.on('bankCard', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.bankCard(socket.id);
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
