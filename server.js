// Tank Arena Multiplayer -- Phase 2 server
// Authoritative game loop: every connected browser is a thin client that sends its input and
// renders whatever state this server broadcasts. Phase 2 adds simple bot opponents (free-for-all --
// bots fight players AND each other) so the arena isn't empty with only 1-2 real players online.
// Still no TDM bases, no class tree -- deliberately cut down and built up in passes.

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

const BOT_COUNT = 3;              // always topped back up to this many if some die or never existed
const BOT_AGGRO_RANGE = 500;      // spot a target from this far
const BOT_GIVEUP_RANGE = 700;     // drop the target if it gets farther than this
const BOT_KITE_RANGE = 260;       // preferred standoff distance once engaged
const BOT_RETARGET_INTERVAL = 0.6;
const BOT_WANDER_MIN = 2, BOT_WANDER_MAX = 5;

const COLORS = [
  ['#4fd0e8', '#3aa6bf'], ['#ff8a5c', '#c25a34'], ['#8ae05c', '#5aa634'],
  ['#e85cd0', '#a634a6'], ['#e8c85c', '#a68e34'], ['#5c8ae8', '#345aa6'],
  ['#e85c5c', '#a63434'], ['#5ce8b0', '#34a680'],
];
const BOT_COLOR = ['#9a9a9a', '#5a5a5a'];

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
// bots: Map<id, botState> -- same shape minus ws/input, plus its own AI state (aiTarget etc).
// ids: real players get positive ids (1, 2, 3...), bots get negative ids (-1, -2, -3...) so the
// two id spaces never collide and it's obvious at a glance which is which when debugging.
const players = new Map();
const bots = new Map();
let bullets = []; // {id, ownerId, x, y, vx, vy, life}
let nextPlayerId = 1;
let nextBotId = -1;
let nextBulletId = 1;

function allCombatants() {
  // spread once per call is fine at this scale (<=5 players + a few bots) -- not worth a persistent
  // cached array for a room this small
  return [...players.values(), ...bots.values()];
}

function makePlayer(ws, id) {
  const spawn = randomSpawn();
  const [color, outline] = COLORS[id % COLORS.length];
  return {
    id, ws, isBot: false, name: '玩家' + id, color, outline,
    x: spawn.x, y: spawn.y, angle: 0,
    hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, alive: true,
    fireCooldown: 0, respawnTimer: 0, score: 0,
    input: { mvx: 0, mvy: 0, angle: 0, firing: false },
  };
}

function makeBot(id) {
  const spawn = randomSpawn();
  return {
    id, isBot: true, name: '機器人' + (-id), color: BOT_COLOR[0], outline: BOT_COLOR[1],
    x: spawn.x, y: spawn.y, angle: 0,
    hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, alive: true,
    fireCooldown: 0, respawnTimer: 0, score: 0,
    aiTarget: null, aiRetarget: 0,
    wanderX: spawn.x, wanderY: spawn.y, wanderTimer: 0,
  };
}

// off by default -- any connected player can flip this (there's no "host"/permission concept in
// this small a room), and it applies to everyone immediately: turning it off clears all current
// bots right away rather than just stopping replenishment
let botsEnabled = false;

function ensureBotPopulation() {
  if (!botsEnabled) return;
  while (bots.size < BOT_COUNT) {
    const id = nextBotId--;
    bots.set(id, makeBot(id));
  }
}

function respawnEntity(e) {
  const spawn = randomSpawn();
  e.x = spawn.x; e.y = spawn.y;
  e.hp = e.maxHp;
  e.alive = true;
  e.fireCooldown = 0;
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

function stepPlayer(p, dt) {
  if (!p.alive) {
    p.respawnTimer -= dt;
    if (p.respawnTimer <= 0) respawnEntity(p);
    return;
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

// simple free-for-all AI: nearest living target (player OR another bot) within aggro range, kite
// at a fixed standoff distance once engaged, fire whenever a target is held, wander when idle
function stepBot(b, dt) {
  if (!b.alive) {
    b.respawnTimer -= dt;
    if (b.respawnTimer <= 0) respawnEntity(b);
    return;
  }

  b.aiRetarget -= dt;
  if (b.aiRetarget <= 0) {
    b.aiRetarget = BOT_RETARGET_INTERVAL;
    let best = null, bestD = BOT_AGGRO_RANGE * BOT_AGGRO_RANGE;
    for (const other of allCombatants()) {
      if (other === b || !other.alive) continue;
      const d = dist2(b.x, b.y, other.x, other.y);
      if (d < bestD) { bestD = d; best = other; }
    }
    b.aiTarget = best;
  }

  let target = b.aiTarget;
  if (target && !target.alive) target = b.aiTarget = null;
  if (target && dist2(b.x, b.y, target.x, target.y) > BOT_GIVEUP_RANGE * BOT_GIVEUP_RANGE) {
    target = b.aiTarget = null;
  }

  let mvx = 0, mvy = 0;
  if (target) {
    const dx = target.x - b.x, dy = target.y - b.y;
    const d = Math.hypot(dx, dy) || 1;
    b.angle = Math.atan2(dy, dx);
    if (d > BOT_KITE_RANGE + 30) { mvx = dx / d; mvy = dy / d; }
    else if (d < BOT_KITE_RANGE - 30) { mvx = -dx / d; mvy = -dy / d; }

    b.fireCooldown -= dt;
    if (b.fireCooldown <= 0) {
      fireBullet(b);
      b.fireCooldown = FIRE_COOLDOWN;
    }
  } else {
    b.wanderTimer -= dt;
    if (b.wanderTimer <= 0) {
      b.wanderTimer = BOT_WANDER_MIN + Math.random() * (BOT_WANDER_MAX - BOT_WANDER_MIN);
      const s = randomSpawn();
      b.wanderX = s.x; b.wanderY = s.y;
    }
    const dx = b.wanderX - b.x, dy = b.wanderY - b.y;
    const d = Math.hypot(dx, dy);
    if (d > 20) { b.angle = Math.atan2(dy, dx); mvx = dx / d; mvy = dy / d; }
  }

  b.x += mvx * PLAYER_SPEED * dt;
  b.y += mvy * PLAYER_SPEED * dt;
  b.x = clamp(b.x, PLAYER_RADIUS, WORLD.w - PLAYER_RADIUS);
  b.y = clamp(b.y, PLAYER_RADIUS, WORLD.h - PLAYER_RADIUS);
}

function tick() {
  const dt = 1 / TICK_RATE;

  ensureBotPopulation();
  for (const p of players.values()) stepPlayer(p, dt);
  for (const b of bots.values()) stepBot(b, dt);

  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }
  bullets = bullets.filter(b =>
    b.life > 0 && b.x > -50 && b.x < WORLD.w + 50 && b.y > -50 && b.y < WORLD.h + 50);

  // bullet vs any living combatant (player or bot) -- consumed by the first enemy it touches.
  // rebuilt fresh each tick since a player can connect/disconnect or a bot can die between ticks
  const hitRadius2 = (PLAYER_RADIUS + BULLET_RADIUS) * (PLAYER_RADIUS + BULLET_RADIUS);
  for (const bullet of bullets) {
    if (bullet.life <= 0) continue;
    for (const e of allCombatants()) {
      if (!e.alive || e.id === bullet.ownerId) continue;
      if (dist2(e.x, e.y, bullet.x, bullet.y) < hitRadius2) {
        e.hp -= BULLET_DAMAGE;
        bullet.life = 0;
        if (e.hp <= 0) {
          e.alive = false;
          e.respawnTimer = RESPAWN_DELAY;
          const shooter = players.get(bullet.ownerId) || bots.get(bullet.ownerId);
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
    botsEnabled,
    players: allCombatants().map(p => ({
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
    } else if (msg.t === 'setBotsEnabled') {
      botsEnabled = !!msg.enabled;
      if (!botsEnabled) bots.clear();
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
