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

const PLACE_DURATION = 45000; // ms to pick a card, walk & aim each round
const NEXT_ROUND_DELAY = 3000; // pause after reveal before next round starts
const HIT_WIDTH = 0.3; // base perpendicular tolerance of a shot
const MIN_ISLAND_SIZE = 6;
const SHRINK_FACTOR = 0.8;

// ---- Special cards (dealt one per player each round) ----
const CARD_IDS = ['gobig', 'gosmall', 'divine', 'bounce', 'thunder'];
const FORK_ANGLE = 0.2618; // 15deg -> two bullets 30deg apart (The Divine)
const THUNDER_RADIUS = 1.6; // ~1 block kill radius (The Thunder)
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
const POWER_IDS = ['matrix', 'drunken', 'revenger', 'fool', 'man'];
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

  startRound() {
    this.round += 1;
    this.state = 'placing';
    const half = this.islandSize / 2 - 0.6;
    const aliveList = [...this.players.values()].filter(p => p.alive);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.ready = false;
      p.shotTargetId = null;
      // deal a fresh random special card each round
      p.card = CARD_IDS[Math.floor(Math.random() * CARD_IDS.length)];
      p.cardTarget = null;
      if (p.isBot) {
        // bots decide their final hiding spot right away; nobody can see them move anyway
        this.decideBotMove(p, half);
        p.ready = true;
        // bots play their card on a random alive player (possibly themselves)
        p.cardTarget = aliveList[Math.floor(Math.random() * aliveList.length)].id;
      } else {
        // small random jitter around center so overlapping spawns aren't identical
        p.x = (Math.random() - 0.5) * 1.5;
        p.z = (Math.random() - 0.5) * 1.5;
        p.angle = Math.random() * Math.PI * 2;
      }
    }
    this.roundEndsAt = Date.now() + PLACE_DURATION;
    const roster = aliveList.map(p => ({ id: p.id, name: p.name, color: p.color }));
    io.to(this.code).emit('roundStart', {
      round: this.round,
      islandSize: this.islandSize,
      duration: PLACE_DURATION,
      endsAt: this.roundEndsAt,
      bounds: half,
      roster
    });
    // privately tell each real player which card they were dealt this round
    for (const p of aliveList) {
      if (!p.isBot) io.to(p.id).emit('yourCard', { card: p.card });
    }
    io.to(this.spectatorRoom).emit('spectateSnapshot', {
      round: this.round,
      players: [...this.players.values()].filter(p => p.alive).map(p => ({
        id: p.id, name: p.name, color: p.color, hat: p.hat, back: p.back,
        x: p.x, z: p.z, angle: p.angle
      }))
    });
    this.broadcastReady();
    clearTimeout(this.timer);
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length > 0 && alive.every(p => p.ready)) {
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
    const fx = new Map(); // id -> { size, fork, bounce, thunder }
    for (const p of alive) fx.set(p.id, { size: 1, fork: false, bounce: false, thunder: false });
    const cards = []; // who cast what on whom (for the reveal display)
    for (const caster of alive) {
      let targetId = caster.cardTarget;
      if (!targetId || !aliveMap.has(targetId)) {
        targetId = alive[Math.floor(Math.random() * alive.length)].id;
      }
      caster.cardTarget = targetId;
      const e = fx.get(targetId);
      switch (caster.card) {
        case 'gobig': e.size *= goBigScale(); break;
        case 'gosmall': e.size *= goSmallScale(); break;
        case 'divine': e.fork = true; break;
        case 'bounce': e.bounce = true; break;
        case 'thunder': e.thunder = true; break;
      }
      cards.push({ casterId: caster.id, card: caster.card, targetId });
    }

    const firingOrder = shuffle(alive);
    const stillAlive = new Set(alive.map(p => p.id));
    const shots = [];

    const foolKilled = new Set(); // victims whose latent power The Fool neutralised this round

    // cast one straight segment. The Matrix lets its owner dodge the first hit of the match —
    // the bullet floats past to whoever stands behind — unless the shooter is The Fool.
    const castSegment = (ox, oz, ang, shooter, excludeIds, dodgeOut) => {
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const cands = [];
      for (const t of alive) {
        if (t.id === shooter.id || !stillAlive.has(t.id) || excludeIds.has(t.id)) continue;
        const vx = t.x - ox, vz = t.z - oz;
        const fwd = vx * dx + vz * dz;
        if (fwd <= 0.05) continue;
        const perp = Math.abs(vx * dz - vz * dx);
        if (perp <= effHitWidth(fx.get(shooter.id).size, fx.get(t.id).size)) cands.push({ t, fwd });
      }
      cands.sort((a, b) => a.fwd - b.fwd);
      const exitDist = rayExit(ox, oz, dx, dz, fieldHalf);
      for (const c of cands) {
        if (c.fwd > exitDist) break;
        const t = c.t;
        if (t.power === 'matrix' && !t.matrixUsed && shooter.power !== 'fool') {
          t.matrixUsed = true;
          dodgeOut.push(t.id);
          continue; // dodged
        }
        return { hitId: t.id, x: t.x, z: t.z, exited: false };
      }
      const d = Math.min(exitDist, 40);
      return { hitId: null, x: ox + dx * d, z: oz + dz * d, exited: exitDist < 40 };
    };

    // resolve one bullet (with bounces / MAN ricochets / Fool suppression), mutating shooterHits + ev
    const fireBullet = (shooter, a0, bounces, shooterHits, ev) => {
      const segments = [];
      let ox = shooter.x, oz = shooter.z, ang = a0, bouncesLeft = bounces;
      for (let step = 0; step < 4; step++) {
        const r = castSegment(ox, oz, ang, shooter, shooterHits, ev.dodges);
        const seg = { x1: ox, z1: oz, x2: r.x, z2: r.z, hitId: null };
        segments.push(seg);
        if (r.hitId) {
          const victim = aliveMap.get(r.hitId);
          // The MAN ricochets any shot that strikes his back (unless the shooter is The Fool)
          if (shooter.power !== 'fool' && victim && victim.power === 'man' && hitFromBehind(ang, victim.angle)) {
            seg.manDeflect = victim.id;
            ev.man.push(victim.id);
            ox = r.x; oz = r.z; ang = Math.random() * Math.PI * 2;
            continue; // survives, does not consume a bounce
          }
          seg.hitId = r.hitId;
          shooterHits.add(r.hitId);
          // The Fool neutralises the victim's latent power (faked on screen, then a clown slap)
          if (shooter.power === 'fool' && victim && victim.power) {
            ev.fool.push({ victimId: victim.id, fakedPower: victim.power });
            foolKilled.add(victim.id);
          }
          if (bouncesLeft > 0) { bouncesLeft--; ox = r.x; oz = r.z; ang = Math.random() * Math.PI * 2; continue; }
          break;
        } else if (r.exited && bouncesLeft > 0) {
          bouncesLeft--; ox = r.x; oz = r.z; ang = inwardAngle(r.x, r.z); continue;
        } else break;
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
      const shooterHits = new Set();
      const ev = { dodges: [], man: [], fool: [] };
      const bullets = angles.map(a0 => ({ segments: fireBullet(shooter, a0, e.bounce ? 1 : 0, shooterHits, ev) }));
      shooterHits.forEach(id => stillAlive.delete(id));
      shots.push({
        shooterId: shooter.id, type: 'shot', bullets, hitIds: [...shooterHits],
        dodges: ev.dodges, manDeflects: ev.man, foolGags: ev.fool, drunken
      });
    }

    // The Revenger: anyone who fell this round (and wasn't neutralised by The Fool) fires a
    // final bullet in a random direction as they drop.
    for (const dead of alive.filter(p => !stillAlive.has(p.id))) {
      if (dead.power !== 'revenger' || foolKilled.has(dead.id)) continue;
      const shooterHits = new Set();
      const ev = { dodges: [], man: [], fool: [] };
      const segments = fireBullet(dead, Math.random() * Math.PI * 2, 0, shooterHits, ev);
      shooterHits.forEach(id => stillAlive.delete(id));
      shots.push({
        shooterId: dead.id, type: 'shot', revenge: true, bullets: [{ segments }], hitIds: [...shooterHits],
        dodges: ev.dodges, manDeflects: ev.man, foolGags: ev.fool, drunken: false
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

  socket.on('useCard', ({ targetId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.setCardTarget(socket.id, targetId);
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
