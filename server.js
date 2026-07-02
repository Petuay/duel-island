const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PLACE_DURATION = 40000; // ms to walk & aim each round
const REVEAL_DURATION = 9000; // ms showing the fire animation / results
const NEXT_ROUND_DELAY = 4000; // pause after reveal before next round starts
const HIT_WIDTH = 0.6; // perpendicular tolerance of the laser "beam"
const MIN_ISLAND_SIZE = 8;
const SHRINK_FACTOR = 0.8;

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
  return Math.min(30, Math.max(12, 10 + Math.ceil(playerCount * 1.6)));
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.state = 'lobby'; // lobby | placing | reveal | ended
    this.players = new Map(); // id -> player
    this.round = 0;
    this.islandSize = 16;
    this.timer = null;
    this.roundEndsAt = 0;
    this.botCounter = 0;
  }

  publicPlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, alive: p.alive, isBot: !!p.isBot
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
      alive: true, shotTargetId: null, isBot: true
    });
  }

  removeBot(id) {
    const p = this.players.get(id);
    if (p && p.isBot) this.players.delete(id);
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
    for (const p of this.players.values()) p.alive = true;
    this.islandSize = computeIslandSize(this.players.size);
    this.startRound();
  }

  startRound() {
    this.round += 1;
    this.state = 'placing';
    const half = this.islandSize / 2 - 0.6;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.isBot) {
        // bots decide their final hiding spot right away; nobody can see them move anyway
        this.decideBotMove(p, half);
      } else {
        // small random jitter around center so overlapping spawns aren't identical
        p.x = (Math.random() - 0.5) * 1.5;
        p.z = (Math.random() - 0.5) * 1.5;
        p.angle = Math.random() * Math.PI * 2;
      }
    }
    this.roundEndsAt = Date.now() + PLACE_DURATION;
    io.to(this.code).emit('roundStart', {
      round: this.round,
      islandSize: this.islandSize,
      duration: PLACE_DURATION,
      endsAt: this.roundEndsAt,
      bounds: half
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.resolveRound(), PLACE_DURATION);
  }

  handleMove(id, x, z, angle) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state !== 'placing') return;
    const half = this.islandSize / 2 - 0.6;
    p.x = Math.max(-half, Math.min(half, x));
    p.z = Math.max(-half, Math.min(half, z));
    p.angle = angle;
  }

  resolveRound() {
    if (this.state !== 'placing') return;
    this.state = 'reveal';
    clearTimeout(this.timer);

    const alive = [...this.players.values()].filter(p => p.alive);
    const hitBy = new Map(); // targetId -> shooterId

    for (const shooter of alive) {
      const dx = Math.sin(shooter.angle);
      const dz = Math.cos(shooter.angle);
      let closestTarget = null;
      let closestDist = Infinity;

      for (const target of alive) {
        if (target.id === shooter.id) continue;
        const vx = target.x - shooter.x;
        const vz = target.z - shooter.z;
        const forwardDist = vx * dx + vz * dz;
        if (forwardDist <= 0.05) continue; // must be in front
        const perp = Math.abs(vx * dz - vz * dx);
        if (perp <= HIT_WIDTH && forwardDist < closestDist) {
          closestDist = forwardDist;
          closestTarget = target;
        }
      }
      if (closestTarget) {
        shooter.shotTargetId = closestTarget.id;
        hitBy.set(closestTarget.id, shooter.id);
      } else {
        shooter.shotTargetId = null;
      }
    }

    const eliminated = [];
    for (const p of alive) {
      if (hitBy.has(p.id)) {
        p.alive = false;
        eliminated.push(p.id);
      }
    }

    const payload = {
      round: this.round,
      islandSize: this.islandSize,
      players: [...this.players.values()]
        .filter(p => alive.includes(p) || eliminated.includes(p.id))
        .map(p => ({
          id: p.id, name: p.name, color: p.color,
          x: p.x, z: p.z, angle: p.angle,
          alive: p.alive, shotTargetId: p.shotTargetId || null,
          wasHit: eliminated.includes(p.id)
        })),
      eliminated,
      survivors: this.aliveIds()
    };
    io.to(this.code).emit('roundResult', payload);

    this.timer = setTimeout(() => this.afterReveal(), REVEAL_DURATION);
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
    for (const p of this.players.values()) p.alive = true;
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
      shotTargetId: null
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

  socket.on('playAgain', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;
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
