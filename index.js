// index.js
// Simple multiplayer API for Street Hunt
// Express + SQLite (better-sqlite3)
// Designed for Render.com (just deploy repo, start: node index.js)

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 4000;
const DB_FILE = process.env.DB_FILE || 'data.db';

const app = express();
app.use(cors());
app.use(express.json());

// --- DB init ---
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// create tables if not exists
db.prepare(`
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  startRadius INTEGER,
  shrinkStepSec INTEGER,
  shrinkAmount INTEGER,
  startedAt INTEGER
);
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room TEXT,
  name TEXT,
  role TEXT,
  status TEXT DEFAULT 'ready',
  lastSeen INTEGER,
  FOREIGN KEY(room) REFERENCES rooms(code)
);
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS locations (
  playerId TEXT PRIMARY KEY,
  lat REAL,
  lng REAL,
  ts INTEGER,
  FOREIGN KEY(playerId) REFERENCES players(id)
);
`).run();

// --- utils ---
const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();
const now = () => Date.now();
const clamp = (v,min,max) => Math.max(min, Math.min(max, v));

// haversine distance (meters) - compute digit-by-digit carefully
function distMeters(aLat, aLng, bLat, bLng) {
  if ([aLat,aLng,bLat,bLng].some(x => x === null || x === undefined)) return Infinity;
  const R = 6371000; // meters
  const toRad = deg => deg * Math.PI / 180.0;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDlat = Math.sin(dLat/2);
  const sinDlon = Math.sin(dLon/2);
  const A = sinDlat*sinDlat + Math.cos(lat1)*Math.cos(lat2)*sinDlon*sinDlon;
  const C = 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1-A));
  return R * C;
}

// --- room endpoints ---

// create room
app.post('/rooms', (req, res) => {
  const startRadius = clamp(parseInt(req.body.startRadius || 800), 20, 100000);
  const shrinkStepSec = clamp(parseInt(req.body.shrinkStepSec || 20), 1, 86400);
  const shrinkAmount = clamp(parseInt(req.body.shrinkAmount || 50), 1, 100000);
  const code = uid();
  db.prepare(`INSERT INTO rooms(code,startRadius,shrinkStepSec,shrinkAmount,startedAt) VALUES(?,?,?,?,NULL)`)
    .run(code, startRadius, shrinkStepSec, shrinkAmount);
  res.json({ ok:true, code, startRadius, shrinkStepSec, shrinkAmount });
});

// start game in room
app.post('/rooms/:code/start', (req, res) => {
  const code = req.params.code.toUpperCase();
  const nowTs = Date.now();
  const r = db.prepare(`UPDATE rooms SET startedAt = ? WHERE code = ?`).run(nowTs, code);
  if (r.changes === 0) return res.status(404).json({ ok:false, error:'room not found' });
  res.json({ ok:true, startedAt: nowTs });
});

// get room info (internal)
function getRoom(code) {
  return db.prepare(`SELECT * FROM rooms WHERE code = ?`).get(code);
}

// --- player endpoints ---

// join
app.post('/join', (req, res) => {
  const room = (req.body.room || '').toUpperCase();
  const name = (req.body.name || 'Player').slice(0,40);
  const role = (req.body.role === 'runner') ? 'runner' : 'hunter';
  if(!room) return res.status(400).json({ ok:false, error:'room required' });
  const roomRow = getRoom(room);
  if(!roomRow) return res.status(404).json({ ok:false, error:'room not found' });
  const id = uuidv4();
  const ts = Date.now();
  db.prepare(`INSERT INTO players(id,room,name,role,lastSeen) VALUES(?,?,?,?,?)`).run(id, room, name, role, ts);
  res.json({ ok:true, id, name, role, room });
});

// leave
app.post('/leave', (req, res) => {
  const id = req.body.playerId;
  if(!id) return res.status(400).json({ ok:false, error:'playerId required' });
  db.prepare(`DELETE FROM players WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM locations WHERE playerId = ?`).run(id);
  res.json({ ok:true });
});

// location update (upsert)
app.post('/location', (req, res) => {
  const { playerId, lat, lng } = req.body;
  if(!playerId || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ ok:false, error:'missing fields' });
  const ts = Date.now();
  const p = db.prepare(`SELECT id FROM players WHERE id = ?`).get(playerId);
  if(!p) return res.status(404).json({ ok:false, error:'player not found' });
  // upsert location
  db.prepare(`
    INSERT INTO locations(playerId,lat,lng,ts) VALUES(?,?,?,?)
    ON CONFLICT(playerId) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, ts=excluded.ts
  `).run(playerId, lat, lng, ts);
  db.prepare(`UPDATE players SET lastSeen = ? WHERE id = ?`).run(ts, playerId);
  res.json({ ok:true, ts });
});

// --- game logic on state request ---
// catch detection and per-player visibility handled when state requested

app.get('/state/:room', (req, res) => {
  const room = (req.params.room || '').toUpperCase();
  const viewerId = req.query.playerId || null;
  const roomRow = getRoom(room);
  if(!roomRow) return res.status(404).json({ ok:false, error:'room not found' });

  // compute dynamic zone radius based on startedAt and shrink settings
  let zoneRadius = Number(roomRow.startRadius || 800);
  if (roomRow.startedAt) {
    const elapsedMs = Date.now() - roomRow.startedAt;
    const steps = Math.floor(elapsedMs / (Math.max(1, roomRow.shrinkStepSec) * 1000));
    zoneRadius = Math.max(20, zoneRadius - steps * (roomRow.shrinkAmount || 50));
  }

  // load players + locations
  const playerRows = db.prepare(`SELECT p.id,p.name,p.role,p.status,p.lastSeen, l.lat, l.lng, l.ts
    FROM players p LEFT JOIN locations l ON p.id = l.playerId
    WHERE p.room = ?
  `).all(room);

  // compute catches: if any hunter within catchMeters of runner -> runner.status = 'caught'
  // we get catchMeters from query param or default 30
  const catchMeters = parseInt(req.query.catchMeters || '30');

  // build helper map and compute distances
  const players = {};
  for(const r of playerRows){
    players[r.id] = {
      id: r.id,
      name: r.name,
      role: r.role,
      status: r.status || 'ready',
      lastSeen: r.lastSeen || null,
      lat: (r.lat !== null && r.lat !== undefined) ? r.lat : null,
      lng: (r.lng !== null && r.lng !== undefined) ? r.lng : null,
      locTs: r.ts || null
    };
  }

  // detect catches and update statuses in DB if newly caught
  for(const aId in players){
    const a = players[aId];
    if(a.role !== 'hunter' || a.lat === null) continue;
    for(const bId in players){
      if(aId === bId) continue;
      const b = players[bId];
      if(b.role !== 'runner' || b.lat === null) continue;
      const d = distMeters(a.lat, a.lng, b.lat, b.lng);
      if(d <= catchMeters){
        if(b.status !== 'caught'){
          players[bId].status = 'caught';
          db.prepare(`UPDATE players SET status = ? WHERE id = ?`).run('caught', bId);
        }
      }
    }
  }

  // compute what to send to viewer
  const viewer = viewerId && players[viewerId] ? players[viewerId] : null;
  const sendPlayers = [];

  // precompute nearest distances for runners/hunters
  for(const id in players){
    const p = players[id];
    let nearestOpp = { id: null, dist: Infinity };
    for(const id2 in players){
      if(id === id2) continue;
      const q = players[id2];
      if(q.lat === null || q.lng === null) continue;
      // opponents = opposite role
      if(p.role === q.role) continue;
      const d = distMeters(p.lat, p.lng, q.lat, q.lng);
      if(d < nearestOpp.dist){ nearestOpp = { id: q.id, dist: d }; }
    }
    p._nearestOpp = nearestOpp; // internal
  }

  for(const id in players){
    const p = players[id];
    if(!viewer){ // anonymous viewer -> minimal info
      sendPlayers.push({ id: p.id, name: p.name, role: p.role, status: p.status });
      continue;
    }
    if(viewer.role === 'hunter'){
      // hunters see positions of everyone (including runners)
      sendPlayers.push({
        id: p.id,
        name: p.name,
        role: p.role,
        status: p.status,
        lat: p.lat,
        lng: p.lng,
        lastSeen: p.lastSeen,
        distanceToViewer: (p.lat!=null && viewer.lat!=null) ? Math.round(distMeters(viewer.lat, viewer.lng, p.lat, p.lng)) : null
      });
    } else { // viewer is runner
      if(p.id === viewer.id){
        // own data: include own loc
        sendPlayers.push({
          id: p.id, name: p.name, role: p.role, status: p.status, lat: p.lat, lng: p.lng, lastSeen: p.lastSeen
        });
      } else if(p.role === 'hunter'){
        // do NOT send hunter coordinates — only distance to RUNNER
        const d = p._nearestOpp && p._nearestOpp.dist ? Math.round(distMeters(viewer.lat, viewer.lng, p.lat, p.lng)) : null;
        sendPlayers.push({
          id: p.id,
          name: p.name,
          role: p.role,
          status: p.status,
          distanceToRunner: (viewer.lat!=null && p.lat!=null) ? Math.round(distMeters(viewer.lat, viewer.lng, p.lat, p.lng)) : null,
          lastSeen: p.lastSeen
        });
      } else {
        // other runners: minimal info
        sendPlayers.push({ id: p.id, name: p.name, role: p.role, status: p.status, lastSeen: p.lastSeen });
      }
    }
  }

  res.json({
    ok: true,
    room: {
      code: roomRow.code,
      startRadius: roomRow.startRadius,
      shrinkStepSec: roomRow.shrinkStepSec,
      shrinkAmount: roomRow.shrinkAmount,
      startedAt: roomRow.startedAt,
      zoneRadius
    },
    players: sendPlayers,
    now: Date.now()
  });
});

// --- admin / debug endpoint to list all rooms (optional) ---
app.get('/rooms', (req, res) => {
  const rows = db.prepare(`SELECT * FROM rooms`).all();
  res.json({ ok:true, rooms: rows });
});

// health
app.get('/', (req,res) => res.send({ ok:true, msg:'Street Hunt API running' }));

app.listen(PORT, () => {
  console.log(`Street Hunt API listening on port ${PORT} (DB: ${DB_FILE})`);
});
