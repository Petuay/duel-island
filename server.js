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

const CARD_PICK_DURATION = 10000; // ms to choose 1 of 3 dealt cards
const PLACE_DURATION = 20000; // ms to walk, aim & aim the chosen card
const NEXT_ROUND_DELAY = 3000; // pause after reveal before next round starts
const HIT_WIDTH = 0.3; // base perpendicular tolerance of a shot
const MIN_ISLAND_SIZE = 6;
const SHRINK_FACTOR = 0.8;

// ---- Special cards (dealt one per player each round) ----
// player-target cards + area cards (placed on the ground instead of a player)
const CARD_IDS = ['gobig', 'gosmall', 'divine', 'bounce', 'thunder', 'mirror', 'wall', 'cyclone', 'firework'];
const AREA_CARDS = new Set(['wall', 'cyclone', 'firework']);
const FORK_ANGLE = 0.2618; // 15deg -> two bullets 30deg apart (The Divine)
const THUNDER_RADIUS = 1.6; // ~1 block kill radius (The Thunder)
const FIREWORK_KILL = 1.5; // half-size of the 3x3 block explosion

// build an axis-aligned obstacle box for an area card at (x,z)
function makeObstacle(i, type, x, z) {
  if (type === 'wall') {
    // 1x3 wall, oriented so the long side is tangential to the field centre (acts as a shield)
    const longZ = Math.abs(x) >= Math.abs(z);
    return { i, type, x, z,
      minX: x - (longZ ? 0.5 : 1.5), maxX: x + (longZ ? 0.5 : 1.5),
      minZ: z - (longZ ? 1.5 : 0.5), maxZ: z + (longZ ? 1.5 : 0.5), longZ };
  }
  const h = type === 'cyclone' ? 1.0 : 0.5; // cyclone 2x2, firework 1x1
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
// size multipliers for Go Big / Go Small (10% chance of the extreme version)
function goBigScale() { return Math.random() < 0.1 ? 3.0 : 1.7; }
function goSmallScale() { return Math.random() < 0.1 ? 0.3 : 0.55; }
// effective perpendicular hit tolerance, widened by a big target / big bullet
function effHitWidth(shooterSize, targetSize) {
  return Math.max(0.05, HIT_WIDTH + (targetSize - 1) * 0.4 + (shooterSize - 1) * 0.15);
}
// distance along a ray (ox,oz)+t(dx,dz) until it leaves the square field of half-size `half`
function rayExit(ox, oz, dx, dz, half) {
  let t = 40;
  if (dx > 1e-6) t = Math.min(t, (half - ox) / dx);
  else if (dx < -1e-6) t = Math.min(t, (-half - ox) / dx);
  if (dz > 1e-6) t = Math.min(t, (half - oz) / dz);
  else if (dz < -1e-6) t = Math.min(t, (-half - oz) / dz);
  return Math.max(0.1, t);
}
// a random direction that points generally back toward the island centre (for edge bounces)
function inwardAngle(x, z) {
  return Math.atan2(-x, -z) + (Math.random() - 0.5) * Math.PI;
}

// ---- Hidden latent powers (one per player, fixed for the whole match) ----
const POWER_IDS = ['matrix', 'drunken', 'revenger', 'man'];
// is a bullet travelling at `bulletAng` striking a player facing `faceAng` from behind?
function hitFromBehind(bulletAng, faceAng) {
  return Math.sin(bulletAng) * Math.sin(faceAng) + Math.cos(bulletAng) * Math.cos(faceAng) > 0.15;
}

const HAT_IDS = ['none', 'party', 'tophat', 'halo', 'horns', 'bunny', 'crown', 'propeller', 'chef'];
const BACK_IDS = ['none', 'devilwing', 'chickenwing', 'angelwing', 'jetpack', 'cape', 'balloon'];

// sequential fire animation timing (mirrored client-side in main.js)
const SHOT_START_DELAY = 4200; // pause (also the firing-order shuffle window) before the first shot
const SHOT_INTERVAL = 1300; // gap between each player's turn to fire
const SHOT_END_PAUSE = 800; // pause after the last shot before advancing

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
      id: p.id, name: p.name, color: p.color, alive: p.alive, isBot: !!p.isBot, hat: p.hat, back: p.back
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
      hat: HAT_IDS[1 + Math.floor(Math.random() * (HAT_IDS.length - 1))],
      back: BACK_IDS[1 + Math.floor(Math.random() * (BACK_IDS.length - 1))]
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

  setCardTarget(id, targetId) {
    if (this.state !== 'placing') return;
    const p = this.players.get(id);
    const t = this.players.get(targetId);
    if (!p || !p.alive || p.ready) return;
    if (!t || !t.alive) return;
    p.cardTarget = targetId;
    io.to(id).emit('cardTargetSet', { targetId });
  }

  setCardArea(id, x, z) {
    if (this.state !== 'placing') return;
    const p = this.players.get(id);
    if (!p || !p.alive || p.ready || !AREA_CARDS.has(p.card)) return;
    const lim = this.islandSize / 2 - 0.5;
    p.cardArea = { x: Math.max(-lim, Math.min(lim, x)), z: Math.max(-lim, Math.min(lim, z)) };
    io.to(id).emit('cardAreaSet', p.cardArea);
  }

  decideBotMove(bot, half) {
    bot.x = (Math.random() * 2 - 1) * half;
    bot.z = (Math.random() * 2 - 1) * half;
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
      // each player secretly gets one hidden latent power for the whole match
      p.power = POWER_IDS[Math.floor(Math.random() * POWER_IDS.length)];
      p.matrixUsed = false; // The Matrix dodge is a once-per-match trigger
    }
    this.islandSize = computeIslandSize(this.players.size);
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
      p.cardTarget = null;
      p.cardArea = null;
      // deal 3 distinct random cards to choose from
      const pool = CARD_IDS.slice();
      p.cardChoices = [];
      for (let i = 0; i < 3 && pool.length; i++) p.cardChoices.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
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
      if (p.isBot) {
        this.decideBotMove(p, half);
        p.ready = true;
        if (AREA_CARDS.has(p.card)) {
          p.cardArea = { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
        } else {
          p.cardTarget = aliveList[Math.floor(Math.random() * aliveList.length)].id;
        }
      } else {
        p.x = (Math.random() - 0.5) * 1.5;
        p.z = (Math.random() - 0.5) * 1.5;
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
      if (!p.isBot) io.to(p.id).emit('yourCard', { card: p.card });
    }
    io.to(this.spectatorRoom).emit('spectateSnapshot', {
      round: this.round,
      players: aliveList.map(p => ({
        id: p.id, name: p.name, color: p.color, hat: p.hat, back: p.back,
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
    p.x = Math.max(-half, Math.min(half, x));
    p.z = Math.max(-half, Math.min(half, z));
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

    // 1. resolve every card (auto-assign a random target if the player never picked one)
    //    and accumulate the per-player effects it produces.
    const fx = new Map(); // id -> { size, fork, bounce, thunder, mirror }
    for (const p of alive) fx.set(p.id, { size: 1, fork: false, bounce: false, thunder: false, mirror: false });
    const cards = []; // player-target cards (for the reveal display)
    const obstacles = []; // area cards placed on the field
    const areaLim = fieldHalf - 0.5;
    for (const caster of alive) {
      // area cards drop an obstacle on the field instead of hitting a player
      if (AREA_CARDS.has(caster.card)) {
        let a = caster.cardArea;
        if (!a) a = { x: (Math.random() * 2 - 1) * areaLim, z: (Math.random() * 2 - 1) * areaLim };
        a = { x: Math.max(-areaLim, Math.min(areaLim, a.x)), z: Math.max(-areaLim, Math.min(areaLim, a.z)) };
        caster.cardArea = a;
        obstacles.push(makeObstacle(obstacles.length, caster.card, a.x, a.z));
        continue;
      }
      let targetId = caster.cardTarget;
      if (!targetId || !aliveMap.has(targetId)) {
        targetId = alive[Math.floor(Math.random() * alive.length)].id;
      }
      caster.cardTarget = targetId;
      const e = fx.get(targetId);
      switch (caster.card) {
        // size cards stack (multiply) when several are cast on the same target
        case 'gobig': e.size *= goBigScale(); break;
        case 'gosmall': e.size *= goSmallScale(); break;
        case 'divine': e.fork = true; break;
        case 'bounce': e.bounce = true; break;
        case 'thunder': e.thunder = true; break;
        case 'mirror': e.mirror = true; break;
      }
      cards.push({ casterId: caster.id, card: caster.card, targetId });
    }

    const firingOrder = shuffle(alive);
    const stillAlive = new Set(alive.map(p => p.id));
    const shots = [];

    // cast one straight segment. `selfId` is the id the bullet won't hit (its owner); it changes
    // after a Mirror reflection so the shot can fly back into the original shooter.
    // The Matrix lets its owner dodge the first hit of the match (bullet floats past to whoever's
    // behind) — but a Mirror card on that target overrides the dodge (card beats power).
    const castSegment = (ox, oz, ang, shooter, selfId, excludeIds, excludeObs, dodgeOut) => {
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
      const exitDist = rayExit(ox, oz, dx, dz, fieldHalf);
      // nearest area-card obstacle along the ray
      let obs = null, obsT = Infinity;
      for (const o of obstacles) {
        if (excludeObs.has(o.i)) continue;
        const t = rayAABB(ox, oz, dx, dz, o.minX, o.maxX, o.minZ, o.maxZ);
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
      return { type: 'miss', hitId: null, x: ox + dx * d, z: oz + dz * d, exited: exitDist < 40 };
    };

    // resolve one bullet (bounces / MAN ricochets / Mirror reflections / area obstacles), collecting kills + events
    const fireBullet = (shooter, a0, bounces, kills, ev) => {
      const segments = [];
      const touched = new Set(kills); // never interact with the same player twice on one bullet
      const touchedObs = new Set();
      let ox = shooter.x, oz = shooter.z, ang = a0, bouncesLeft = bounces, selfId = shooter.id;
      for (let step = 0; step < 8; step++) {
        const r = castSegment(ox, oz, ang, shooter, selfId, touched, touchedObs, ev.dodges);
        const seg = { x1: ox, z1: oz, x2: r.x, z2: r.z, hitId: null };
        segments.push(seg);
        if (r.type === 'wall') { seg.wall = true; break; } // กำแพงกันดิน blocks the shot
        if (r.type === 'cyclone') { // ลมหมุน whirls the shot off in a random direction
          seg.cyclone = true; touchedObs.add(r.obs.i);
          ox = r.x; oz = r.z; ang = Math.random() * Math.PI * 2;
          continue;
        }
        if (r.type === 'firework') { // พลุไฟ blows up, killing everyone in a 3x3 block
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
          if (bouncesLeft > 0) { bouncesLeft--; ox = r.x; oz = r.z; ang = Math.random() * Math.PI * 2; continue; }
          break;
        }
        // miss / left the field
        if (r.exited && bouncesLeft > 0) { bouncesLeft--; ox = r.x; oz = r.z; ang = inwardAngle(r.x, r.z); continue; }
        break;
      }
      return segments;
    };

    for (const shooter of firingOrder) {
      if (!stillAlive.has(shooter.id)) {
        shots.push({ shooterId: shooter.id, type: 'skip', skipped: true, hitIds: [] });
        continue;
      }
      const e = fx.get(shooter.id);

      // The Thunder replaces the normal directional shot
      if (e.thunder) {
        if (Math.random() < 0.5) {
          shots.push({ shooterId: shooter.id, type: 'thunder', jammed: true, hitIds: [] });
        } else {
          const victims = [];
          for (const t of alive) {
            if (t.id === shooter.id || !stillAlive.has(t.id)) continue;
            if (Math.hypot(t.x - shooter.x, t.z - shooter.z) <= THUNDER_RADIUS) victims.push(t.id);
          }
          victims.forEach(id => stillAlive.delete(id));
          shots.push({ shooterId: shooter.id, type: 'thunder', jammed: false, hitIds: victims });
        }
        continue;
      }

      // The Drunken: a third of the time the shot fires out the back instead
      let baseAngle = shooter.angle, drunken = false;
      if (shooter.power === 'drunken' && Math.random() < 1 / 3) { baseAngle += Math.PI; drunken = true; }

      // one or two bullets (The Divine forks into two), each able to bounce once (The Bounce)
      const angles = e.fork ? [baseAngle - FORK_ANGLE, baseAngle + FORK_ANGLE] : [baseAngle];
      const kills = new Set();
      const ev = { dodges: [], man: [], mirror: [] };
      const bullets = angles.map(a0 => ({ segments: fireBullet(shooter, a0, e.bounce ? 1 : 0, kills, ev) }));
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

    const eliminated = [];
    for (const p of alive) {
      if (!stillAlive.has(p.id)) {
        p.alive = false;
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
          id: p.id, name: p.name, color: p.color, hat: p.hat, back: p.back,
          x: p.x, z: p.z, angle: p.angle,
          alive: p.alive,
          wasHit: eliminated.includes(p.id),
          size: (fx.get(p.id) || {}).size || 1,
          card: p.card, cardTargetId: p.cardTarget
        })),
      shots,
      cards,
      obstacles: obstacles.map(o => ({ type: o.type, x: o.x, z: o.z, minX: o.minX, maxX: o.maxX, minZ: o.minZ, maxZ: o.maxZ, longZ: o.longZ })),
      eliminated,
      survivors: this.aliveIds()
    };
    io.to(this.code).emit('roundResult', payload);

    const revealDuration = SHOT_START_DELAY + shots.length * SHOT_INTERVAL + SHOT_END_PAUSE;
    this.timer = setTimeout(() => this.afterReveal(), revealDuration);
  }

  afterReveal() {
    const survivors = this.aliveIds();
    if (survivors.length <= 1) {
      this.state = 'ended';
      const winner = survivors[0] ? this.players.get(survivors[0]) : null;
      io.to(this.code).emit('gameOver', {
        winnerId: winner ? winner.id : null,
        winnerName: winner ? winner.name : null
      });
      return;
    }
    this.islandSize = Math.max(MIN_ISLAND_SIZE, Math.round(this.islandSize * SHRINK_FACTOR));
    this.timer = setTimeout(() => this.startRound(), NEXT_ROUND_DELAY);
    io.to(this.code).emit('nextRoundCountdown', { delay: NEXT_ROUND_DELAY, islandSize: this.islandSize });
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
      hat: 'none',
      back: 'none'
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

  socket.on('setHat', ({ hat }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p || !HAT_IDS.includes(hat)) return;
    p.hat = hat;
    room.broadcastRoom();
  });

  socket.on('setBack', ({ back }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p || !BACK_IDS.includes(back)) return;
    p.back = back;
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

  socket.on('pickCard', ({ card }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.pickCard(socket.id, card);
  });

  socket.on('useCard', ({ targetId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.setCardTarget(socket.id, targetId);
  });

  socket.on('useCardArea', ({ x, z }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.setCardArea(socket.id, x, z);
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
