// Tank Arena Multiplayer -- Phase 1 server
// Authoritative game loop: every connected browser is a thin client that sends its input and
// renders whatever state this server broadcasts. No bots, no TDM bases, no class tree yet --
// deliberately cut down to "N real players fight each other in one shared room" so it's small
// enough to actually ship, verify, and build on.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const WORLD = { w: 2000, h: 2000 };
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 240;       // px/s
const PLAYER_MAX_HP = 100;
const FIRE_COOLDOWN = 0.25;     // seconds between shots
const BULLET_SPEED = 560;
const BULLET_RADIUS = 6;
const BULLET_LIFE = 1.4;        // seconds
const BULLET_DAMAGE = 12;
const RESPAWN_DELAY = 2.0;      // seconds
const TICK_RATE = 20;           // broadcasts/sec
const MAX_NAME_LEN = 12;

const COLORS = [
  ['#4fd0e8', '#3aa6bf'], ['#ff8a5c', '#c25a34'], ['#8ae05c', '#5aa634'],
  ['#e85cd0', '#a634a6'], ['#e8c85c', '#a68e34'], ['#5c8ae8', '#345aa6'],
  ['#e85c5c', '#a63434'], ['#5ce8b0', '#34a680'],
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist2(x1, y1, x2, y2) { const dx = x1 - x2, dy = y1 - y2; return dx * dx + dy * dy; }

function randomSpawn() {
  return {
    x: 100 + Math.random() * (WORLD.w - 200),
    y: 100 + Math.random() * (WORLD.h - 200),
  };
}

// players: Map<id, playerState>. playerState.ws is the live socket; everything else is plain data
// that gets stepped every tick and (minus ws/input) sent out in the broadcast snapshot.
const players = new Map();
let bullets = []; // {id, ownerId, x, y, vx, vy, life}
let nextPlayerId = 1;
let nextBulletId = 1;

function makePlayer(ws, id) {
  const spawn = randomSpawn();
  const [color, outline] = COLORS[id % COLORS.length];
  return {
    id, ws, name: '玩家' + id, color, outline,
    x: spawn.x, y: spawn.y, angle: 0,
    hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, alive: true,
    fireCooldown: 0, respawnTimer: 0, score: 0,
    input: { mvx: 0, mvy: 0, angle: 0, firing: false },
  };
}

function respawnPlayer(p) {
  const spawn = randomSpawn();
  p.x = spawn.x; p.y = spawn.y;
  p.hp = p.maxHp;
  p.alive = true;
  p.fireCooldown = 0;
}

function fireBullet(p) {
  bullets.push({
    id: nextBulletId++,
    ownerId: p.id,
    x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 4),
    y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 4),
    vx: Math.cos(p.angle) * BULLET_SPEED,
    vy: Math.sin(p.angle) * BULLET_SPEED,
    life: BULLET_LIFE,
  });
}

function tick() {
  const dt = 1 / TICK_RATE;

  for (const p of players.values()) {
    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) respawnPlayer(p);
      continue;
    }
    const mvx = p.input.mvx, mvy = p.input.mvy;
    const len = Math.hypot(mvx, mvy);
    if (len > 0.01) {
      p.x += (mvx / len) * PLAYER_SPEED * dt;
      p.y += (mvy / len) * PLAYER_SPEED * dt;
    }
    p.x = clamp(p.x, PLAYER_RADIUS, WORLD.w - PLAYER_RADIUS);
    p.y = clamp(p.y, PLAYER_RADIUS, WORLD.h - PLAYER_RADIUS);
    p.angle = p.input.angle;

    p.fireCooldown -= dt;
    if (p.input.firing && p.fireCooldown <= 0) {
      fireBullet(p);
      p.fireCooldown = FIRE_COOLDOWN;
    }
  }

  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }
  bullets = bullets.filter(b =>
    b.life > 0 && b.x > -50 && b.x < WORLD.w + 50 && b.y > -50 && b.y < WORLD.h + 50);

  // bullet vs player -- a bullet is consumed by the first live enemy it touches
  const hitRadius2 = (PLAYER_RADIUS + BULLET_RADIUS) * (PLAYER_RADIUS + BULLET_RADIUS);
  for (const b of bullets) {
    if (b.life <= 0) continue;
    for (const p of players.values()) {
      if (!p.alive || p.id === b.ownerId) continue;
      if (dist2(p.x, p.y, b.x, b.y) < hitRadius2) {
        p.hp -= BULLET_DAMAGE;
        b.life = 0;
        if (p.hp <= 0) {
          p.alive = false;
          p.respawnTimer = RESPAWN_DELAY;
          const shooter = players.get(b.ownerId);
          if (shooter) shooter.score++;
        }
        break;
      }
    }
  }
  bullets = bullets.filter(b => b.life > 0);

  broadcastState();
}

function broadcastState() {
  const state = {
    t: 'state',
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, outline: p.outline,
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, angle: p.angle,
      hp: p.hp, maxHp: p.maxHp, alive: p.alive, score: p.score,
    })),
    bullets: bullets.map(b => ({ x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 })),
  };
  const msg = JSON.stringify(state);
  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const id = nextPlayerId++;
  const player = makePlayer(ws, id);
  players.set(id, player);

  ws.send(JSON.stringify({
    t: 'welcome', id, world: WORLD,
    color: player.color, outline: player.outline,
    playerRadius: PLAYER_RADIUS, bulletRadius: BULLET_RADIUS,
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'input') {
      // never trust the network -- clamp everything to sane ranges before it touches sim state
      player.input.mvx = clamp(Number(msg.mvx) || 0, -1, 1);
      player.input.mvy = clamp(Number(msg.mvy) || 0, -1, 1);
      if (typeof msg.angle === 'number' && Number.isFinite(msg.angle)) player.input.angle = msg.angle;
      player.input.firing = !!msg.firing;
    } else if (msg.t === 'setName' && typeof msg.name === 'string') {
      const clean = msg.name.trim().slice(0, MAX_NAME_LEN);
      if (clean) player.name = clean;
    }
  });

  ws.on('close', () => {
    players.delete(id);
  });
});

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tank Arena multiplayer server listening on port ${PORT}`);
});
