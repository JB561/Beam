/* BEAM server — zero dependencies.
   • serves the app (static, cache-friendly)
   • /api/sig  — tiny rendezvous queue so two devices can trade WebRTC tickets
   • /api/config — tells the client which ICE setup fits this host
   The server NEVER sees file bytes: transfers run device-to-device.            */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const ROOT = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;          // SDP tickets are a few KB
const ROOM_TTL = 4 * 60 * 1000;       // rooms idle out after 4 minutes
const MSG_KEEP = 60;
const MAX_ROOMS = 800;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.woff2': 'font/woff2'
};

/* ── rendezvous rooms ─────────────────────────────────────── */
const rooms = new Map();   // code -> { seq, seen: {host, join}, msgs: [{seq, from, data}] }

function room(code) {
  let r = rooms.get(code);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) {         // drop the stalest room
      let oldestKey = null, oldest = Infinity;
      for (const [k, v] of rooms) { const t = Math.max(v.seen.host, v.seen.join); if (t < oldest) { oldest = t; oldestKey = k; } }
      if (oldestKey) rooms.delete(oldestKey);
    }
    r = { seq: 0, seen: { host: Date.now(), join: Date.now() }, msgs: [] };
    rooms.set(code, r);
  }
  return r;
}
setInterval(() => {
  const cut = Date.now() - ROOM_TTL;
  for (const [k, v] of rooms) if (Math.max(v.seen.host, v.seen.join) < cut) rooms.delete(k);
}, 60000).unref();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleSig(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    const code = (url.searchParams.get('room') || '').toUpperCase().slice(0, 10);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'join';
    const since = Number(url.searchParams.get('since')) || 0;
    if (!/^[A-Z0-9-]{4,10}$/.test(code)) return json(res, 400, { error: 'bad room' });
    const r = room(code);
    r.seen[role] = Date.now();
    const other = role === 'host' ? 'join' : 'host';
    const msgs = r.msgs.filter(m => m.from === other && m.seq > since).map(m => ({ seq: m.seq, data: m.data }));
    const hb = r.msgs.length ? r.msgs[r.msgs.length - 1] : null;
    return json(res, 200, {
      msgs,
      othersAlive: Date.now() - r.seen[other] < 90000,
      last: hb ? hb.seq : 0
    });
  }
  if (req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const code = String(body.room || '').toUpperCase().slice(0, 10);
    const role = body.role === 'host' ? 'host' : body.role === 'join' ? 'join' : null;
    if (!role || !/^[A-Z0-9-]{4,10}$/.test(code)) return json(res, 400, { error: 'bad room/role' });
    const t = String(body.t || '').slice(0, 20);
    const r = room(code);
    r.seen[role] = Date.now();
    if (t === 'cancel') {                  // wipes the room — both sides start clean
      r.msgs = [];
      return json(res, 200, { ok: true, reset: true });
    }
    const data = { t };
    if (typeof body.sdp === 'string' && body.sdp.length < 200000) data.sdp = body.sdp;
    if (typeof body.ver === 'number' && isFinite(body.ver)) data.ver = body.ver | 0;
    if (body.c && typeof body.c === 'object') data.c = body.c;
    if (typeof body.ua === 'string') data.ua = body.ua.slice(0, 100);
    const msg = { seq: ++r.seq, from: role, data };
    r.msgs.push(msg);
    if (r.msgs.length > MSG_KEEP) r.msgs.splice(0, r.msgs.length - MSG_KEEP);
    return json(res, 200, { ok: true, seq: msg.seq });
  }
  json(res, 405, { error: 'method' });
}

/* ── static files ─────────────────────────────────────────── */
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    const head = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest'
        ? 'no-cache' : 'public, max-age=86400',
      'x-content-type-options': 'nosniff'
    };
    res.writeHead(200, head);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/sig') return await handleSig(req, res);
    if (url.pathname === '/api/config') {
      const wantLocal = process.env.BEAM_ICE === 'local';
      const host = (req.headers.host || '').split(':')[0];
      return json(res, 200, { ice: wantLocal ? 'local' : 'full', host });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`BEAM running on port ${PORT}`);
  console.log(`  local :  http://localhost:${PORT}`);
  for (const n of nets) console.log(`  LAN   :  http://${n.address}:${PORT}`);
});
module.exports = { server, rooms };
