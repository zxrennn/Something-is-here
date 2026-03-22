// Something Is Here — Multiplayer Server v2.0.0
// Deploy free on Railway: railway up
// Or Render: connect repo, set start command to "node server.js"

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const BLOCKED = ['fuck','shit','bitch','cunt','nigger','nigga','faggot','retard','whore','cock','dick','pussy','bastard','piss','slut','asshole'];
function filterText(str) {
  if (!str || typeof str !== 'string') return '';
  let out = str.slice(0, 64);
  BLOCKED.forEach(w => { out = out.replace(new RegExp(w, 'gi'), '*'.repeat(w.length)); });
  return out.trim();
}
function hasBlocked(str) {
  if (!str) return false;
  const low = str.toLowerCase();
  return BLOCKED.some(w => low.includes(w));
}

const rooms = new Map();

function genCode() {
  let c; do { c = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(c));
  return c;
}

class Room {
  constructor(code, hostId, gamemode) {
    this.code = code; this.hostId = hostId; this.gamemode = gamemode;
    this.state = 'lobby'; this.players = new Map();
    this.maxPlayers = 5; this.chat = [];
    this.gs = null; this.tickInt = null; this.timerInt = null;
  }

  send(id, msg) {
    const p = this.players.get(id);
    if (p?.ws?.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, skip = null) {
    const d = JSON.stringify(msg);
    for (const [id, p] of this.players) if (id !== skip && p.ws?.readyState === 1) p.ws.send(d);
  }

  pub() {
    return {
      code: this.code, gamemode: this.gamemode, state: this.state,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, skin: p.skin, title: p.title,
        role: p.role, x: p.x, y: p.y, score: p.score, alive: p.alive,
        keys: p.keys || 0, escaped: p.escaped || false
      }))
    };
  }

  startGame() {
    if (this.state !== 'lobby') return;
    this.state = 'playing';
    const ps = [...this.players.values()];
    const shuffled = [...ps].sort(() => Math.random() - 0.5);

    if (this.gamemode === 'versus') {
      const nm = ps.length <= 3 ? 1 : 2;
      shuffled.forEach((p, i) => {
        p.role = i < nm ? 'monster' : 'survivor';
        p.alive = true; p.score = 0;
        p.x = p.role === 'monster' ? 650 + Math.random()*40 : 80 + Math.random()*100;
        p.y = 80 + Math.random() * 200;
      });
      this.gs = { timeLeft: 120 };
    } else {
      shuffled.forEach((p, i) => {
        p.role = 'survivor'; p.alive = true; p.score = 0; p.keys = 0; p.escaped = false;
        p.x = 80 + i * 50; p.y = 80;
      });
      this.gs = {
        keys: Array.from({ length: 6 }, (_, i) => ({ id: i, x: 100 + Math.random()*600, y: 100 + Math.random()*250, collected: false })),
        keysNeeded: 3, exitOpen: false,
        exit: { x: 680, y: 290 },
        escaped: 0, timeLeft: 180,
        aiMonster: { x: 680, y: 290, angle: 0, mstate: 'patrol', alert: 0, lkx: 0, lky: 0, wtx: null, wty: null }
      };
    }

    this.broadcast({ type: 'game_start', room: this.pub(), gs: this.gs });
    this.tickInt = setInterval(() => this.tick(), 50);
    this.timerInt = setInterval(() => {
      if (this.state !== 'playing' || !this.gs) return;
      this.gs.timeLeft--;
      if (this.gs.timeLeft <= 0) this.endGame('time_up');
    }, 1000);
  }

  tick() {
    if (this.state !== 'playing') return;
    const positions = [...this.players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, angle: p.angle||0, alive: p.alive, role: p.role, score: p.score, keys: p.keys||0, escaped: p.escaped||false }));
    this.broadcast({ type: 'tick', positions, gs: this.gs });

    if (this.gamemode === 'versus') {
      const surv = [...this.players.values()].filter(p => p.role === 'survivor');
      const mons = [...this.players.values()].filter(p => p.role === 'monster');
      if (surv.length && surv.every(p => !p.alive)) { this.endGame('monsters_win'); return; }
      if (mons.length && mons.every(p => !p.alive)) { this.endGame('survivors_win'); return; }
    } else if (this.gamemode === 'escape' && this.gs) {
      const surv = [...this.players.values()].filter(p => p.role === 'survivor');
      if (surv.length && surv.every(p => !p.alive || p.escaped)) { this.endGame('escaped'); }
    }
  }

  handleMove(id, data) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    if (typeof data.x === 'number') p.x = data.x;
    if (typeof data.y === 'number') p.y = data.y;
    if (typeof data.angle === 'number') p.angle = data.angle;
  }

  handleAction(id, data) {
    const p = this.players.get(id);
    if (!p || this.state !== 'playing') return;

    if (this.gamemode === 'versus' && p.role === 'monster' && data.action === 'catch') {
      for (const [, s] of this.players) {
        if (s.role === 'survivor' && s.alive && Math.hypot(s.x-p.x, s.y-p.y) < 38) {
          s.alive = false; p.score += 100;
          this.broadcast({ type: 'caught', caughtId: s.id, catcherId: id });
        }
      }
    }

    if (this.gamemode === 'escape' && data.action === 'pickup_key' && this.gs) {
      for (const k of this.gs.keys) {
        if (!k.collected && Math.hypot(k.x-p.x, k.y-p.y) < 30) {
          k.collected = true; p.keys = (p.keys||0)+1; p.score += 50;
          const total = this.gs.keys.filter(k=>k.collected).length;
          if (total >= this.gs.keysNeeded) { this.gs.exitOpen = true; this.broadcast({ type: 'exit_open' }); }
          this.broadcast({ type: 'key_picked', keyId: k.id, playerId: id, total });
          break;
        }
      }
    }

    if (this.gamemode === 'escape' && data.action === 'escape_exit' && this.gs?.exitOpen) {
      const ex = this.gs.exit;
      if (Math.hypot(ex.x-p.x, ex.y-p.y) < 44 && !p.escaped) {
        p.escaped = true; p.score += 200; this.gs.escaped++;
        this.broadcast({ type: 'player_escaped', playerId: id, total: this.gs.escaped });
      }
    }

    if (this.gamemode === 'versus' && p.role === 'survivor' && data.action === 'orb' && data.score) {
      p.score = Math.max(p.score, data.score);
    }
  }

  endGame(result) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    clearInterval(this.tickInt); clearInterval(this.timerInt);
    this.broadcast({ type: 'game_over', result, room: this.pub() });
    setTimeout(() => rooms.delete(this.code), 60000);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('SIH Multiplayer Server v2.0.0');
});

const wss = new WebSocketServer({ server });
let uid = 1;

wss.on('connection', ws => {
  const id = String(uid++);
  let room = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'create') {
      const name = filterText(m.name || 'Player');
      if (hasBlocked(name)) { ws.send(JSON.stringify({ type: 'error', msg: 'Name blocked.' })); return; }
      const gm = m.gamemode === 'versus' ? 'versus' : 'escape';
      const code = genCode();
      room = new Room(code, id, gm);
      room.players.set(id, { id, name, skin: m.skin||'default', title: m.title||'', ws, x:80, y:80, angle:0, role:'host', alive:true, score:0 });
      rooms.set(code, room);
      ws.send(JSON.stringify({ type: 'created', code, room: room.pub() }));
      return;
    }

    if (m.type === 'join') {
      const code = (m.code||'').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found.' })); return; }
      if (r.state !== 'lobby') { ws.send(JSON.stringify({ type: 'error', msg: 'Game in progress.' })); return; }
      if (r.players.size >= r.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full.' })); return; }
      const name = filterText(m.name || 'Player');
      if (hasBlocked(name)) { ws.send(JSON.stringify({ type: 'error', msg: 'Name blocked.' })); return; }
      r.players.set(id, { id, name, skin: m.skin||'default', title: m.title||'', ws, x:80, y:80, angle:0, role:'player', alive:true, score:0 });
      room = r;
      ws.send(JSON.stringify({ type: 'joined', room: r.pub() }));
      r.broadcast({ type: 'player_joined', room: r.pub() }, id);
      return;
    }

    if (!room) return;

    if (m.type === 'start') {
      if (room.hostId !== id) return;
      if (room.players.size < 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Need 2+ players.' })); return; }
      room.startGame();
    }
    else if (m.type === 'move') room.handleMove(id, m);
    else if (m.type === 'action') room.handleAction(id, m);
    else if (m.type === 'chat') {
      const text = filterText(m.text||'');
      if (!text) return;
      const p = room.players.get(id);
      const entry = { from: p?.name||'?', title: p?.title||'', text, ts: Date.now() };
      room.chat.push(entry); if (room.chat.length > 100) room.chat.shift();
      room.broadcast({ type: 'chat', entry });
    }
    else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });

  ws.on('close', () => {
    if (!room) return;
    room.players.delete(id);
    room.broadcast({ type: 'player_left', playerId: id, room: room.pub() });
    if (room.players.size === 0) {
      clearInterval(room.tickInt); clearInterval(room.timerInt); rooms.delete(room.code);
    } else if (room.hostId === id && room.state === 'lobby') {
      const newHost = [...room.players.keys()][0];
      room.hostId = newHost; room.send(newHost, { type: 'you_are_host' });
    }
  });
});

server.listen(PORT, () => console.log(`SIH server on :${PORT}`));
