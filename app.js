/* ═══════════════════════════════════════════════════════════════
   BEAM — device-to-device file transfer
   No signup, no cloud, no upload. Two devices, one direct link.
   Works on the same Wi-Fi / hotspot, or across the internet.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── helpers ──────────────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();

function rnd(n, mod = 36) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(mod).padStart(2, '0')).join('').slice(0, n);
}
function uid(n = 12) { return rnd(n); }
function fmtBytes(n) {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
const fmtSpeed = bps => bps > 100 ? fmtBytes(bps) + '/s' : '—';
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return Math.ceil(sec) + 's left';
  if (sec < 3600) return Math.ceil(sec / 60) + ' min left';
  return Math.ceil(sec / 3600) + 'h left';
}
function b64url(bytes) {
  let s = ''; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder().decode(b);

/* label masking so device/file labels aren't readable on the relay */
function xorMask(bytes, code) {
  const kb = utf8('beam:' + code), out = new Uint8Array(bytes);
  for (let i = 0; i < out.length; i++) out[i] ^= kb[i % kb.length] ^ ((i * 31) & 255);
  return out;
}
const maskStr = (s, code) => { try { return b64url(xorMask(utf8(s), code)); } catch { return null; } };
const unmaskStr = (s, code) => { try { return fromUtf8(xorMask(b64urlDecode(s), code)); } catch { return null; } };

/* ── toasts / log / status ────────────────────────────────── */
function toast(msg, kind = '', ms = 3400) {
  const box = $('#toasts');
  const live = [...box.children];
  if (live.length >= 3) { const old = live[0]; old.classList.add('out'); setTimeout(() => old.remove(), 320); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}
function log(msg) {
  const el = $('#log'); if (!el) return;
  el.textContent += `[${new Date().toLocaleTimeString([], { hour12: false })}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-20000);
}
function setNet(state, text) {
  $('#netChip').dataset.state = state || '';
  $('#netText').textContent = text;
}

/* ── device / file labels ─────────────────────────────────── */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'This device';
}
const svgPhone = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/></svg>`;
const svgLaptop = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>`;
const deviceIcon = () => /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? svgPhone : svgLaptop;

function fileKind(name = '', mime = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg', 'avif'].includes(ext)) return 'img';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'vid';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(ext)) return 'aud';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'zip';
  return 'bin';
}
const KIND_LABEL = { img: 'IMG', vid: 'VID', aud: 'AUD', zip: 'ZIP', bin: 'FILE' };
function fileExtLabel(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ext && ext.length <= 4 && ext !== name.toLowerCase() ? ext.toUpperCase() : 'FILE';
}
const sanitizeName = n => (String(n || '').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'file');

/* ── screens ──────────────────────────────────────────────── */
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 's-' + id));
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
}
const screen = () => document.body.dataset.screen || 'home';

/* ── modals + QR scanning ─────────────────────────────────── */
let scanHandler = null;          // (text) => keepScanning?
let scanStream = null, scanRAF = 0;

function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; if (id === 'modalScan') stopScan(); }

async function startScan(handler, multi = false) {
  openModal('modalScan');
  $('#scanHint').textContent = 'Point at the other device’s QR code.';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false
    });
  } catch (e) {
    $('#scanHint').textContent = 'Camera unavailable — use “Paste text” instead.';
    log('camera: ' + e.message);
    return;
  }
  const v = $('#scanVideo');
  v.srcObject = scanStream;
  await v.play().catch(() => {});
  const canvas = $('#scanCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!scanStream) return;
    if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth) {
      const scale = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight));
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = window.jsQR && window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (res && res.data && scanHandler) {
        const keep = scanHandler(res.data);
        if (!multi || !keep) {
          const h = scanHandler; scanHandler = null;
          stopScan(); closeModal('modalScan');
          if (!multi) h(res.data);
          return;
        }
      }
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}
function stopScan() {
  cancelAnimationFrame(scanRAF); scanRAF = 0;
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $('#scanVideo'); if (v) v.srcObject = null;
}

/* ── QR drawing / chunked tickets ─────────────────────────── */
function drawQR(canvas, text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount(), quiet = 4, size = count + quiet * 2, px = 8;
  canvas.width = canvas.height = size * px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eaf1ff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#05060a';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++)
    if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
}
function chunksForQR(text, max = 470) {
  const enc = utf8(text), out = [], total = Math.max(1, Math.ceil(enc.length / max));
  for (let i = 0, n = 1; i < enc.length; i += max, n++) {
    const part = fromUtf8(enc.slice(i, i + max));
    out.push(`${n}/${total}|${part.length}|${part}`);
  }
  return out;
}
function parseQRChunks(scanned) {
  const m = /^(\d+)\/(\d+)\|(\d+)\|([\s\S]*)$/.exec(scanned);
  if (!m) return { single: scanned };
  return { idx: +m[1], total: +m[2], payload: m[4] };
}
const qrCollect = { total: 0, parts: new Map() };
function collectChunk(scanned, done) {
  const p = parseQRChunks(scanned);
  if (p.single) { done(scanned); return false; }
  if (qrCollect.total !== p.total) { qrCollect.total = p.total; qrCollect.parts.clear(); }
  const had = qrCollect.parts.has(p.idx);
  qrCollect.parts.set(p.idx, p.payload);
  if (!had) toast(`QR frame ${qrCollect.parts.size}/${qrCollect.total} captured`, 'ok', 1200);
  if (qrCollect.parts.size >= qrCollect.total) {
    let out = '';
    for (let i = 1; i <= qrCollect.total; i++) out += qrCollect.parts.get(i) || '';
    qrCollect.parts.clear(); qrCollect.total = 0;
    done(out);
    return false;
  }
  return true;
}
function showTicketQR(canvas, ticket) {
  const parts = chunksForQR(ticket);
  drawQR(canvas, parts[0]);
  let i = 0;
  let hint = canvas.parentElement.querySelector('.qr-hint');
  let nextBtn = canvas.parentElement.querySelector('.qr-next');
  if (parts.length > 1) {
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'muted center qr-hint';
      hint.style.cssText = 'margin:-4px 0 10px;font-size:.8rem';
      canvas.after(hint);
      canvas.style.cursor = 'pointer';
    }
    if (!nextBtn) {
      nextBtn = document.createElement('button');
      nextBtn.className = 'btn btn-ghost sm qr-next';
      nextBtn.textContent = 'Show next frame →';
      hint.after(nextBtn);
    }
    const label = () => hint.textContent = `showing frame ${i + 1} of ${parts.length} — the other device scans each one`;
    const advance = () => { i = (i + 1) % parts.length; drawQR(canvas, parts[i]); label(); };
    canvas.onclick = advance; nextBtn.onclick = advance; nextBtn.hidden = false;
    label();
    toast(`This ticket needs ${parts.length} QR frames`, '', 4500);
  } else {
    if (hint) hint.remove();
    if (nextBtn) nextBtn.hidden = true;
  }
  return parts.length;
}

/* ── signaling client (rendezvous only — never sees file bytes) ── */
let latestOffer = { code: null, ver: -1, msg: null };
const SIG = {
  code: null, role: null, since: 0, aborted: false,
  async post(body, keepalive = false) {
    return fetch('/api/sig', {
      method: 'POST', keepalive,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: this.code, role: this.role, ...body })
    }).catch(() => null);
  },
  async poll(room = this.code, role = this.role) {
    try {
      const r = await fetch(`/api/sig?room=${encodeURIComponent(room)}&role=${role}&since=${this.since}`);
      if (!r.ok) return [];
      const j = await r.json();
      if (j.msgs) for (const m of j.msgs) {
        if (m.seq > this.since) this.since = m.seq;
        const d = m.data || m;
        if (d && d.t === 'offer' && (!latestOffer.msg || (d.ver || 0) > latestOffer.ver)) {
          latestOffer = { code: room, ver: d.ver || 0, msg: d };
        }
      }
      return j.msgs || [];
    } catch { return []; }
  }
};

/* ── WebRTC peer ──────────────────────────────────────────── */
const ICE_FULL = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};
const ICE_LOCAL = { iceServers: [] };   // offline mode — host candidates only, zero internet

let CHUNK = 64 * 1024;                   // shrinks automatically if a browser refuses a frame
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 2 * 1024 * 1024;

/* binary frame: [ver u8][idLen u8][id utf8][offset f64 LE][payload] */
const _enc = new TextEncoder(), _dec = new TextDecoder();
function frameChunk(id, offset, payload) {
  const idb = _enc.encode(id);
  const buf = new ArrayBuffer(2 + idb.length + 8 + payload.byteLength);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint8(0, 1); dv.setUint8(1, idb.length);
  u8.set(idb, 2);
  dv.setFloat64(2 + idb.length, offset, true);
  u8.set(new Uint8Array(payload), 2 + idb.length + 8);
  return buf;
}
function parseFrame(ab) {
  const dv = new DataView(ab);
  if (dv.getUint8(0) !== 1) return null;
  const idLen = dv.getUint8(1);
  return {
    id: _dec.decode(new Uint8Array(ab, 2, idLen)),
    offset: dv.getFloat64(2 + idLen, true),
    payload: ab.slice(2 + idLen + 8)
  };
}

class Peer {
  constructor() { this.pc = null; this.dc = null; this.closed = true; this.remoteApplied = false; this.icePending = []; }

  async init({ trickle = false, ice = ICE_FULL, createChannel = false } = {}) {
    this.close(true);
    this.closed = false; this.remoteApplied = false; this.icePending = [];
    this.wantTrickle = trickle;
    const pc = this.pc = new RTCPeerConnection(ice);
    this._remoteReady = new Promise(r => this._resRemote = r);
    this._openReady = new Promise(r => this._resOpen = r);
    this._closedReady = new Promise(r => this._resClosed = r);

    pc.onicecandidate = e => {
      if (this.pc !== pc) return;                    // stale connection
      if (e.candidate && this.wantTrickle && this.cbSignal) {
        this.cbSignal({ t: 'ice', c: e.candidate.toJSON ? e.candidate.toJSON() : null });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;                    // stale connection — ignore entirely
      const st = pc.connectionState;
      log('link state: ' + st);
      if (st === 'connected') { this._resOpen && this._resOpen(); }
      if (st === 'failed' || st === 'closed') this.onDead();
      if (st === 'disconnected') setTimeout(() => {
        if (this.pc === pc && pc.connectionState === 'disconnected') this.onDead();
      }, 3500);
    };
    pc.ondatachannel = e => { if (this.pc === pc) this.attach(e.channel); };
    if (createChannel) this.attach(pc.createDataChannel('beam'));
    return this;
  }

  attach(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = () => {
      if (this.dc !== dc) return;
      log('data channel open'); this._resOpen && this._resOpen(); this.cbOpen && this.cbOpen();
    };
    dc.onmessage = e => {
      if (this.dc !== dc) return;
      let msg = e.data;
      if (msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) return this.cbData && this.cbData(msg);
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return; } this.cbData && this.cbData(msg); }
    };
    dc.onclose = () => { if (this.dc !== dc) return; if (!this.closed) this.onDead(); };
  }

  onDead() {
    if (this.closed) return;
    this.closed = true;
    this._resClosed && this._resClosed();
    this.cbClose && this.cbClose();
  }

  async gatherComplete(pc, maxMs = 7000) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(res => {
      const t0 = Date.now();
      const check = () => {
        if (pc.iceGatheringState === 'complete' || Date.now() - t0 > maxMs) {
          pc.removeEventListener('icegatheringstatechange', check); res();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(check, maxMs);
    });
  }
  async createOffer({ complete = false } = {}) {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (complete) await this.gatherComplete(this.pc);
    return this.pc.localDescription.sdp;
  }
  async createAnswer({ complete = false } = {}) {
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    if (complete) await this.gatherComplete(this.pc);
    return this.pc.localDescription.sdp;
  }
  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.remoteApplied = true; this.flushIce(); this._resRemote && this._resRemote();
  }
  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.remoteApplied = true; this.flushIce(); this._resRemote && this._resRemote();
  }
  addIce(c) {
    S.iceSeen = (S.iceSeen || 0) + 1;
    if (!c || !this.pc || this.closed) return;
    if (!this.remoteApplied) { this.icePending.push(c); S.iceQueued = (S.iceQueued || 0) + 1; return; }
    S.iceApplied = (S.iceApplied || 0) + 1;
    this.pc.addIceCandidate(c).catch(() => { S.iceRejected = (S.iceRejected || 0) + 1; });
  }
  flushIce() {
    const q = this.icePending || []; this.icePending = [];
    q.forEach(c => this.pc.addIceCandidate(c).catch(() => {}));
  }
  waitRemote(ms = 30000) { return Promise.race([this._remoteReady, sleep(ms).then(() => { throw new Error('timeout waiting for description'); })]); }
  waitOpen(ms = 30000) { return Promise.race([this._openReady, sleep(ms).then(() => { throw new Error('timeout waiting for link'); })]); }
  waitClosed() { return this._closedReady; }

  send(obj) { if (this.dc && this.dc.readyState === 'open') { this.dc.send(JSON.stringify(obj)); return true; } return false; }
  sendBinary(buf) { if (this.dc && this.dc.readyState === 'open') { this.dc.send(buf); return true; } return false; }
  buffered() { return this.dc ? this.dc.bufferedAmount : 0; }
  async waitDrain() {
    if (!this.dc || this.buffered() < HIGH_WATER || S.dcClosed) return;
    const dc = this.dc;
    await new Promise(res => {
      let done = false;
      const fin = () => { if (done) return; done = true; dc.removeEventListener('bufferedamountlow', fin); res(); };
      dc.addEventListener('bufferedamountlow', fin);
      const iv = setInterval(() => { if (this.buffered() < LOW_WATER || dc.readyState !== 'open') { clearInterval(iv); fin(); } }, 120);
      setTimeout(() => { clearInterval(iv); fin(); }, 4000);
    });
  }
  close(silent) {
    this.closed = true;
    const dc = this.dc, pc = this.pc;
    if (dc) { dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null; try { dc.close(); } catch {} }
    if (pc) { pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null; try { pc.close(); } catch {} }
    this.dc = null; this.pc = null;
    if (!silent && this._resClosed) this._resClosed();
  }
}

/* ── session state ────────────────────────────────────────── */
const S = {
  peer: new Peer(), role: null, mode: null, code: null,
  items: new Map(), order: [], up: 0, down: 0, active: false,
  pumping: false, rxTimer: 0, dcClosed: false,
  retry: 0, reconnecting: false, rxStatusEl: null
};
const stats = { t: 0, upBase: 0, downBase: 0 };

function resetSession() {
  S.items.clear(); S.order.length = 0; S.up = S.down = 0; S.active = false;
  S.pumping = false; S.retry = 0; S.reconnecting = false;
  $('#queue').innerHTML = '';
  updQueueChrome();
}

/* protocol
   {"t":"hello","name"}                      greeting (name masked)
   {"t":"meta","id","size","name","mime","from"}   offer / resume
   {"t":"ok","id","from"}                    accept + resume offset
   <binary frame>                            chunk
   {"t":"ack","id","n"}                      received-so-far
   {"t":"done","id"}                         all bytes sent
   {"t":"have","id"}                         fully stored on receiver
   {"t":"abort","id"}                        cancel
   {"t":"bye"}
*/
function wireUp() {
  const p = S.peer;
  p.cbOpen = () => {
    S.dcClosed = false; S.active = true; S.retry = 0; S.reconnecting = false;
    setNet('ok', 'Link live');
    enterSession();
    $('#statState').textContent = 'live';
    $('#beam').classList.remove('idle'); $('#beam').classList.add('live');
    p.send({ t: 'hello', name: maskStr(deviceName(), S.code) || deviceName() });
    for (const id of S.order) {
      const item = S.items.get(id);
      if (item.dir === 'out' && item.state !== 'done' && item.state !== 'cancelled' && item.state !== 'error') {
        item.accepted = false;
        item.state = 'queued';
        sendMeta(item);
      }
    }
    pumpSend();
    if (S.rxStatusEl) S.rxStatusEl.textContent = '';
  };
  p.cbData = onMessage;
  p.cbClose = () => {
    if (!S.active) return;
    S.active = false; S.dcClosed = true;
    setNet('busy', 'Link dropped');
    $('#statState').textContent = 'reconnecting';
    $('#beam').classList.remove('live');
    $('#peerName').textContent = 'Reconnecting…';
    log('link dropped');
    for (const id of S.order) {
      const item = S.items.get(id);
      if (item.dir === 'out' && item.state === 'sending') item.state = 'paused';
      if (item.dir === 'in' && item.state === 'receiving' && item.mode === 'disk') {
        try { item.writable && item.writable.close(); } catch {}
        item.writable = null; item.sinkReady = false; item.sinkSetup = null;
      }
    }
    renderQueue();
    if (S.mode === 'online') attemptReconnect();
    else setNet('err', 'Link lost');
  };
  p.cbSignal = m => SIG.post(m);
}

/* ── receiving ────────────────────────────────────────────── */
const opfs = {
  root: null, tried: false,
  async get() {
    if (this.tried) return this.root;
    this.tried = true;
    try {
      this.root = navigator.storage && navigator.storage.getDirectory ? await navigator.storage.getDirectory() : null;
    } catch { this.root = null; }
    return this.root;
  }
};
let sinkChain = Promise.resolve();

function sendMeta(item) {
  S.peer.send({
    t: 'meta', id: item.id, size: item.size, from: item.sent || 0, mime: item.mime || '',
    name: item.nameMask || (item.nameMask = maskStr(item.name, S.code) || undefined) || undefined
  });
}

async function onMeta(m) {
  const id = m.id;
  let item = S.items.get(id);
  const name = (m.name && unmaskStr(m.name, S.code)) || m.name || ('file-' + id);
  if (!item) {
    item = {
      id, dir: 'in', name: sanitizeName(name), size: +m.size || 0, mime: m.mime || '',
      recv: 0, sent: 0, state: 'receiving', mode: 'memory', chunks: [],
      t0: now(), lastTick: now(), lastRate: 0, lastRend: 0
    };
    addItem(item);
  } else if (item.state === 'done') {
    S.peer.send({ t: 'have', id });
    return;
  }
  item.state = 'receiving';
  item.metaSeen = true;
  sinkChain = sinkChain.then(async () => {
    if (!item.sinkReady) await prepareSink(item);
    S.peer.send({ t: 'ok', id, from: item.recv | 0 });
    if (item.size === 0) maybeFinishIn(item);
    renderItem(item);
  }).catch(e => { log('sink error: ' + e.message); S.peer.send({ t: 'ok', id, from: 0 }); });
  renderQueue();
}

async function prepareSink(item) {
  if (item.sinkReady) return;
  if (item.size === 0) { item.mode = 'memory'; item.sinkReady = true; return; }
  try {
    const root = await opfs.get();
    if (!root) throw new Error('storage API unavailable');
    const nameForDisk = 'beam-' + item.id + '-' + item.name;
    const handle = await root.getFileHandle(nameForDisk, { create: true });
    const w = await handle.createWritable({ keepExistingData: item.recv > 0 });
    if (item.recv > 0) await w.seek(item.recv);
    item.diskName = nameForDisk; item.writable = w; item.mode = 'disk'; item.sinkReady = true;
    log(`incoming “${item.name}” → device storage`);
  } catch (e) {
    item.mode = 'memory'; item.sinkReady = true;
    if (item.recv === 0) item.chunks = [];
    log(`incoming “${item.name}” → memory (${e.message})`);
  }
}

function onChunk(frame) {
  const item = S.items.get(frame.id);
  if (!item || item.state === 'done') return;
  const s = frame.offset, buf = frame.payload;
  if (item.mode === 'disk') {
    if (s < item.recv) return;
    const w = item.writable;
    if (!w) return;
    if (s !== item.recv) { log('gap in stream at ' + s); return; }
    item.recv += buf.byteLength;
    S.down += buf.byteLength;
    w.write(buf).catch(e => { item.state = 'error'; item.err = 'disk write failed'; log('write: ' + e.message); renderItem(item); });
    ackProgress(item);
  } else {
    if (s < item.recv) return;
    item.chunks.push({ s, b: buf });
    item.recv = Math.max(item.recv, s + buf.byteLength);
    S.down += buf.byteLength;
    ackProgress(item);
  }
  const t = now();
  if (t - item.lastTick > 400) {
    item.lastRate = ((item.recv - (item.lastMoved || 0)) / (t - item.lastTick)) * 1000;
    item.lastMoved = item.recv; item.lastTick = t;
  }
  if (t - item.lastRend > 110) { item.lastRend = t; renderItem(item); touchStats(); }
  maybeFinishIn(item);
  if (!S.rxTimer) S.rxTimer = setTimeout(() => {
    S.rxTimer = 0;
    for (const id of S.order) {
      const it = S.items.get(id);
      if (it && it.dir === 'in' && it.state === 'receiving' && it.recv >= it.size) maybeFinishIn(it);
    }
  }, 4500);
}
function ackProgress(item) {
  if (!item.lastAck || item.recv - item.lastAck > 2 * 1024 * 1024 || item.recv === item.size) {
    item.lastAck = item.recv;
    S.peer.send({ t: 'ack', id: item.id, n: item.recv });
  }
}

async function maybeFinishIn(item) {
  if (!item || item.state !== 'receiving' || !item.sinkReady) return;
  if (!(item.recv >= item.size)) return;
  item.state = 'finishing'; renderItem(item);
  try {
    if (item.mode === 'disk') {
      if (item.writable) { await item.writable.close(); item.writable = null; }
      item.state = 'done'; item.tEnd = now();
      const blob = await saveReadyBlob(item);
      const el = $('#queue').querySelector(`.item[data-id="${item.id}"] .fsub`);
      if (el && blob) el.textContent = `${fmtBytes(item.size)} · complete`;
    } else {
      item.chunks.sort((a, b) => a.s - b.s);
      const parts = []; let total = 0;
      for (const c of item.chunks) { parts.push(c.b); total += c.b.byteLength; }
      item.blob = new Blob(parts, { type: item.mime || 'application/octet-stream' });
      item.chunks = [];
      item.size = item.blob.size; item.recv = item.blob.size;
      item.state = 'done'; item.tEnd = now();
    }
    S.peer.send({ t: 'have', id: item.id });
    toast(`Received “${item.name}” — ${fmtBytes(item.size)}`, 'ok');
  } catch (e) {
    item.state = 'error'; item.err = e.message; log('finalise: ' + e.message);
  }
  renderItem(item); updQueueChrome();
}
async function saveReadyBlob(item) { /* pointer only — file already on disk */ return true; }

/* ── sending ──────────────────────────────────────────────── */
function addFiles(list) {
  const files = [...list].filter(f => f && f.size !== undefined);
  let n = 0;
  for (const f of files) {
    const item = {
      id: uid(12), dir: 'out', name: sanitizeName(f.name || 'file'), size: f.size, mime: f.type || '',
      file: f, sent: 0, peerBytes: 0, state: 'queued', t0: now(), lastTick: now(), lastRate: 0, lastRend: 0
    };
    S.items.set(item.id, item); S.order.push(item.id); n++;
  }
  renderQueue();
  if (n) toast(`Queued ${n} file${n > 1 ? 's' : ''} — ${fmtBytes(files.reduce((a, f) => a + f.size, 0))}`, '', 2200);
  pumpSend();
  return n;
}

async function pumpSend() {
  if (S.pumping) return;
  S.pumping = true;
  try {
    for (let i = 0; i < S.order.length; i++) {
      const item = S.items.get(S.order[i]);
      if (!item || item.dir !== 'out' || ['done', 'cancelled', 'error'].includes(item.state)) continue;
      if (!S.active) { if (item.state === 'sending') item.state = 'paused'; continue; }
      if (!item.accepted) {
        if (!item.metaSent || item.state === 'paused') { sendMeta(item); item.metaSent = true; }
        if (!item.accepted) continue;
      }
      item.state = 'sending'; renderItem(item);
      await sendBody(item);
    }
  } finally { S.pumping = false; renderItemRefresh(); }
}
function renderItemRefresh() { for (const id of S.order) { const it = S.items.get(id); if (it) renderItem(it); } }

async function sendBody(item) {
  while (item.sent < item.size) {
    if (!S.active) { item.state = 'paused'; return; }
    const end = Math.min(item.sent + CHUNK, item.size);
    let buf;
    try { buf = await item.file.slice(item.sent, end).arrayBuffer(); }
    catch (e) { item.state = 'error'; item.err = 'source unreadable'; toast(`Lost access to “${item.name}”`, 'err'); return; }
    if (!buf.byteLength) { item.state = 'error'; item.err = 'read past end'; return; }
    let sent = false;
    try { sent = S.peer.sendBinary(frameChunk(item.id, item.sent, buf)); }
    catch (e) {
      const old = CHUNK; CHUNK = Math.max(16 * 1024, CHUNK / 2);
      log(`frame of ${old}B rejected — chunk size now ${CHUNK}B`);
      continue;                              // retry this slice at the smaller size
    }
    if (!sent) { item.state = 'paused'; return; }
    item.sent += buf.byteLength; S.up += buf.byteLength;
    const t = now();
    if (t - item.lastTick > 400) {
      item.lastRate = ((item.sent - (item.lastMoved || 0)) / (t - item.lastTick)) * 1000;
      item.lastMoved = item.sent; item.lastTick = t;
    }
    if (t - item.lastRend > 110) { item.lastRend = t; renderItem(item); touchStats(); }
    if (S.peer.buffered() > HIGH_WATER) await S.peer.waitDrain();
  }
  S.up -= 0;
  S.peer.send({ t: 'done', id: item.id });
  item.state = 'sent'; renderItem(item); touchStats();
  const t0 = now();
  while (S.active && item.state === 'sent' && now() - t0 < 120000) {
    if ((item.peerBytes || 0) >= item.size) return markSent(item);
    await sleep(400);
  }
  if (item.state === 'sent') markSent(item, !S.active);
}
function markSent(item, warn) {
  if (item.state === 'done') return;
  item.state = 'done'; item.tEnd = now(); renderItem(item); updQueueChrome();
  if (warn) toast(`Sent “${item.name}” (no final confirmation)`);
  else toast(`Delivered “${item.name}” ✓`, 'ok');
}

function onMessage(m) {
  if (m instanceof ArrayBuffer || ArrayBuffer.isView(m)) {
    const f = m instanceof ArrayBuffer ? parseFrame(m) : parseFrame(m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength));
    if (f) onChunk(f);
    return;
  }
  if (typeof m !== 'object' || !m.t) return;
  switch (m.t) {
    case 'hello': {
      const nm = m.name && unmaskStr(m.name, S.code);
      $('#peerName').textContent = nm || 'Connected device';
      log('peer: ' + $('#peerName').textContent);
      break;
    }
    case 'meta': onMeta(m); break;
    case 'ok': {
      const item = S.items.get(m.id); if (!item) return;
      item.accepted = true;
      if (typeof m.from === 'number' && m.from >= 0 && m.from <= item.size) item.sent = m.from;
      if (item.state === 'queued' || item.state === 'paused') item.state = 'sending';
      pumpSend();
      break;
    }
    case 'ack': {
      const item = S.items.get(m.id); if (!item) return;
      item.peerBytes = Math.max(item.peerBytes || 0, +m.n || 0);
      break;
    }
    case 'done': {
      const item = S.items.get(m.id); if (!item) return;
      maybeFinishIn(item); break;
    }
    case 'have': {
      const item = S.items.get(m.id); if (!item) return;
      item.peerBytes = item.size; markSent(item); break;
    }
    case 'abort': {
      const item = S.items.get(m.id); if (!item) return;
      item.state = 'cancelled';
      if (item.writable) { try { item.writable.close(); } catch {} item.writable = null; }
      item.chunks = [];
      renderItem(item); toast(`“${item.name}” cancelled by the other device`);
      break;
    }
    case 'bye': log('peer ended the session'); break;
  }
}

/* ── stats ────────────────────────────────────────────────── */
function touchStats() {
  const t = now();
  if (!stats.t) { stats.t = t; stats.upBase = S.up; stats.downBase = S.down; }
  const dt = (t - stats.t) / 1000;
  if (dt < 0.7) return;
  const upRate = (S.up - stats.upBase) / dt, downRate = (S.down - stats.downBase) / dt;
  stats.t = t; stats.upBase = S.up; stats.downBase = S.down;
  $('#statUp').textContent = fmtBytes(S.up) + (upRate > 300 ? ' · ' + fmtSpeed(upRate) : '');
  $('#statDown').textContent = fmtBytes(S.down) + (downRate > 300 ? ' · ' + fmtSpeed(downRate) : '');
}

/* ── queue rendering ──────────────────────────────────────── */
function addItem(item) {
  S.items.set(item.id, item); S.order.push(item.id);
  renderQueue(); updQueueChrome();
  if (item.dir === 'in') toast(`Incoming: “${item.name}” — ${fmtBytes(item.size)}`);
}
function itemNode(item) {
  const el = document.createElement('div');
  el.className = 'item'; el.dataset.id = item.id;
  el.innerHTML = `<div class="top">
      <span class="file-ic"></span>
      <span class="f-meta"><b class="fname"></b><span class="fsub"></span></span>
      <span class="f-act"></span>
    </div><div class="bar"><i></i></div>`;
  return el;
}
function renderQueue() {
  const q = $('#queue');
  for (const id of S.order) {
    const item = S.items.get(id); if (!item) continue;
    let el = q.querySelector(`.item[data-id="${item.id}"]`);
    if (!el) { el = itemNode(item); q.appendChild(el); }
    renderItem(item);
  }
  $('#queueEmpty').hidden = S.order.length > 0;
  updQueueChrome();
}
function renderItem(item) {
  const el = $('#queue').querySelector(`.item[data-id="${item.id}"]`); if (!el) return;
  const k = fileKind(item.name, item.mime);
  const ic = $('.file-ic', el); ic.dataset.k = k; ic.textContent = k === 'bin' ? fileExtLabel(item.name) : KIND_LABEL[k];
  $('.fname', el).textContent = (item.dir === 'out' ? '↑ ' : '↓ ') + item.name;
  const done = item.state === 'done';
  const moved = item.dir === 'out' ? item.sent : item.recv;
  const pct = item.size ? Math.min(1, moved / item.size) : (done ? 1 : 0);
  const rate = item.lastRate || 0;
  let sub;
  if (done) sub = `${fmtBytes(item.size)} · ${item.tEnd && item.t0 ? ((item.tEnd - item.t0) / 1000).toFixed(1) + 's · ' : ''}complete`;
  else if (item.state === 'error') sub = 'failed · ' + (item.err || 'unknown error');
  else if (item.state === 'cancelled') sub = 'cancelled';
  else if (item.state === 'sent') sub = `${fmtBytes(item.size)} · waiting for confirmation`;
  else sub = `${fmtBytes(moved)} / ${fmtBytes(item.size)}${rate > 300 ? ' · ' + fmtSpeed(rate) : ''}${rate > 300 && item.size > moved ? ' · ' + fmtEta((item.size - moved) / rate) : ''}`;
  $('.fsub', el).textContent = sub;
  const bar = $('.bar', el), fill = $('.bar i', el);
  fill.style.width = (pct * 100).toFixed(2) + '%';
  bar.classList.toggle('in', item.dir === 'in');
  bar.classList.toggle('done', done);

  const pillMap = { queued: ['wait', 'queued'], sending: ['live', 'sending'], sent: ['live', 'finishing'], receiving: ['live', 'receiving'], finishing: ['live', 'storing'], paused: ['wait', 'paused'], done: ['ok', 'done'], error: ['err', 'failed'], cancelled: ['err', 'cancelled'] };
  const [pcls, ptxt] = pillMap[item.state] || ['wait', item.state];
  const act = $('.f-act', el); act.innerHTML = '';
  const tag = document.createElement('span'); tag.className = 'pill ' + pcls; tag.textContent = ptxt; act.appendChild(tag);
  if (done && item.dir === 'in') {
    const b = document.createElement('button'); b.className = 'icon-btn'; b.title = 'Save to this device';
    b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;
    b.onclick = () => saveItem(item); act.appendChild(b);
  }
  if (item.dir === 'out' && !done && item.state !== 'cancelled') {
    const b = document.createElement('button'); b.className = 'icon-btn'; b.title = 'Cancel';
    b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
    b.onclick = () => {
      item.state = 'cancelled'; item.chunks = [];
      if (item.writable) { try { item.writable.close(); } catch {} }
      S.peer.send({ t: 'abort', id: item.id }); renderItem(item);
    };
    act.appendChild(b);
  }
  if (item.state === 'error' || item.state === 'cancelled') {
    const b = document.createElement('button'); b.className = 'icon-btn'; b.title = 'Remove from list';
    b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`;
    b.onclick = () => { S.items.delete(item.id); S.order.splice(S.order.indexOf(item.id), 1); el.remove(); updQueueChrome(); };
    act.appendChild(b);
  }
}
function updQueueChrome() {
  const anyDone = S.order.some(id => S.items.get(id) && S.items.get(id).state === 'done');
  const anyIn = S.order.some(id => { const it = S.items.get(id); return it && it.state === 'done' && it.dir === 'in'; });
  $('#saveAll').hidden = !anyIn;
  $('#clearDone').hidden = !anyDone;
  $('#queueTitle').textContent = S.order.length ? `Files · ${S.order.length}` : 'Files';
}
async function saveItem(item) {
  try {
    if (item.mode === 'disk' && item.diskName) {
      const root = await opfs.get();
      const fh = await root.getFileHandle(item.diskName);
      triggerDownload(await fh.getFile(), item.name);
    } else if (item.blob) triggerDownload(item.blob, item.name);
    else toast('Nothing to save yet', 'err');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
}
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = sanitizeName(name); document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  toast(`Saving “${name}”`, 'ok');
}
async function saveAll() {
  for (const id of [...S.order]) {
    const item = S.items.get(id);
    if (item && item.dir === 'in' && item.state === 'done') { await saveItem(item); await sleep(250); }
  }
}

/* ── session lifecycle ────────────────────────────────────── */
function beginSession(role, mode) {
  resetSession();
  S.role = role; S.mode = mode; SIG.aborted = false;
  wireUp();
  $('#rxStatus').textContent = '';
}
function enterSession() {
  showScreen('session');
  $('#meName').textContent = deviceName();
  $('#meRole').textContent = S.role;
  $('#peerRole').textContent = S.role === 'sender' ? 'receiver' : 'sender';
  $('#meIcon').innerHTML = deviceIcon();
  $('#peerIcon').innerHTML = deviceIcon();
  $('#peerName').textContent = 'Connected';
  $('#sessionStats').hidden = false;
  $('#statLink').textContent = S.mode === 'offline' ? 'direct · local' : 'peer to peer';
  updQueueChrome();
}
async function leaveSession(msg = 'Session ended') {
  SIG.aborted = true; stopHeartbeat(); S.active = false;
  try { S.peer.send({ t: 'bye' }); } catch {}
  try { await SIG.post({ t: 'cancel' }, true); } catch {}
  S.peer.close(true);
  resetSession();
  showScreen('home');
  setNet('', 'P2P engine ready');
  toast(msg);
  S.role = null; S.mode = null; S.code = null;
}

/* ── online pairing ───────────────────────────────────────── */
let hbTimer = 0;
function startHeartbeat() { stopHeartbeat(); hbTimer = setInterval(() => SIG.post({ t: 'hb', ua: navigator.userAgent.slice(0, 60) }), 40000); }
function stopHeartbeat() { clearInterval(hbTimer); hbTimer = 0; }

function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return [...b].map(x => A[x % A.length]).join('');
}

async function hostOnline() {
  beginSession('sender', 'online');
  SIG.code = makeCode(); SIG.role = 'host'; SIG.since = 0; S.code = SIG.code;
  const code = SIG.code;
  showScreen('pair'); showPairPanel('online'); renderCode($('#codeShow'), code);
  $('#pairStatus').textContent = 'Waiting for the other device to join…';
  setNet('busy', 'Waiting for peer');
  log('session code ' + code);
  await SIG.post({ t: 'cancel' });
  await SIG.post({ t: 'hb' });
  startHeartbeat();

  let lastOfferAt = 0, answered = false, offerVer = 0;
  const offerOnce = async () => {
    if (SIG.aborted) return;
    try {
      await S.peer.init({ trickle: true, ice: ICE_FULL, createChannel: true });
      lastOfferAt = now(); answered = false;
      const ver = ++offerVer;
      const sdp = await S.peer.createOffer();
      await SIG.post({ t: 'offer', sdp, ver, ua: navigator.userAgent.slice(0, 60) });
      log('ticket posted (v' + ver + ')');
    } catch (e) { log('offer failed: ' + e.message); }
  };
  await offerOnce();

  const deadline = now() + 30 * 60 * 1000;
  while (!S.active && !SIG.aborted && now() < deadline) {
    for (const wrap of await SIG.poll()) {
      const m = wrap.data || wrap;
      if (m.t === 'want') {
        if (S.active) await SIG.post({ t: 'busy' });
        else if (now() - lastOfferAt > 8000) {
          $('#pairStatus').textContent = 'A device is joining…';
          log('peer wants in — fresh ticket');
          await offerOnce();
        }
      } else if (m.t === 'answer' && !answered) {
        if (m.ver && m.ver !== offerVer) {
          log('answer was for old ticket v' + m.ver + ' (now v' + offerVer + ') — rotating');
          await SIG.post({ t: 'rotate' });
          await offerOnce();
          continue;
        }
        try { await S.peer.acceptAnswer(m.sdp); answered = true; log('answer accepted (v' + (m.ver || '?') + ')'); }
        catch (e) { answered = false; log('bad answer — re-offering'); await offerOnce(); }
      } else if (m.t === 'ice' && m.c) S.peer.addIce(m.c);
    }
    // rotate a stalled ticket, but never mid-handshake
    if (!S.active && !answered && now() - lastOfferAt > 90000 && !SIG.aborted) await offerOnce();
    try { await S.peer.waitOpen(900); } catch {}
  }
  if (SIG.aborted) return;
  if (!S.active) { toast('Nobody joined — link expired', 'err'); return leaveSession('Link expired'); }
}

async function joinOnline(code) {
  beginSession('receiver', 'online');
  SIG.code = code; SIG.role = 'join'; SIG.since = 0; S.code = code;
  latestOffer = { code: null, ver: -1, msg: null };
  setNet('busy', 'Connecting…');
  S.rxStatusEl = $('#rxStatus');
  $('#rxStatus').textContent = `Connecting to ${code}…`;
  log('joining ' + code);

  let lastVer = -1;
  for (let attempt = 1; attempt <= 6 && !SIG.aborted; attempt++) {
    await SIG.post({ t: 'want' });
    let offerMsg;
    try { offerMsg = await waitForOfferN(code, 9000, lastVer); }
    catch (e) { toast('That code is already in a live session', 'err'); return; }
    if (!offerMsg) { log('no fresh ticket (attempt ' + attempt + ')'); await sleep(400); continue; }
    lastVer = offerMsg.ver || 0;
    try {
      await S.peer.init({ trickle: true, ice: ICE_FULL });
      await S.peer.acceptOffer(offerMsg.sdp);
      await SIG.post({ t: 'answer', ver: lastVer, sdp: await S.peer.createAnswer() });
      log('answer posted (attempt ' + attempt + ', v' + lastVer + ')');
      await linkWait(16000);
      return;                       // cbOpen brings up the session screen
    } catch (e) {
      log('attempt ' + attempt + ' failed: ' + e.message);
      S.peer.close(true);
      await sleep(250);
    }
  }
  if (SIG.aborted) return;
  setNet('err', 'No peer');
  $('#rxStatus').textContent = 'No live device with that code. Double-check the 6 characters.';
  toast('No live device found with that code', 'err');
}

/* newest ticket strictly newer than `newerThan`; throws on 'busy' */
async function waitForOfferN(code, ms, newerThan = -1) {
  const t0 = now();
  const cached = () => (latestOffer.msg && latestOffer.code === code && latestOffer.ver > newerThan) ? latestOffer.msg : null;
  let hit = cached();
  if (hit) return hit;
  while (now() - t0 < ms && !SIG.aborted) {
    for (const wrap of await SIG.poll()) {
      const m = wrap.data || wrap;
      if (m.t === 'busy') throw new Error('busy');
      if (m.t === 'ice' && m.c) S.peer.addIce(m.c);
      if (m.t === 'offer' && (!latestOffer.msg || (m.ver || 0) > latestOffer.ver)) {
        latestOffer = { code, ver: m.ver || 0, msg: m };
      }
    }
    hit = cached();
    if (hit) return hit;
    await sleep(600);
  }
  return cached();
}
/* wait for the link, servicing ICE and bailing out the moment the host rotates */
async function linkWait(ms = 16000) {
  const t0 = now();
  while (now() - t0 < ms && !SIG.aborted) {
    for (const wrap of await SIG.poll()) {
      const m = wrap.data || wrap;
      if (m.t === 'ice' && m.c) S.peer.addIce(m.c);
      if (m.t === 'rotate') throw new Error('host rotated its ticket');
      if (m.t === 'cancel') throw new Error('session cancelled');
    }
    if (S.active) return;
    try { await S.peer.waitOpen(700); } catch {}
  }
  if (!S.active) throw new Error('link timeout');
}
async function waitForOffer(code, ms) { return waitForOfferN(code, ms, -1); }

/* ── offline pairing (tickets over QR / copy-paste) ───────── */
async function hostOffline() {
  beginSession('sender', 'offline');
  const sk = uid(16);
  S.code = 'LOCAL-' + sk;                       // shared mask key for this beam
  showScreen('pair'); showPairPanel('offline');
  setNet('busy', 'Building ticket');
  await S.peer.init({ trickle: false, ice: ICE_LOCAL, createChannel: true });
  const sdp = await S.peer.createOffer({ complete: true });
  const ticket = 'BEAM1|' + b64url(utf8(JSON.stringify({ v: 1, k: 'o', sdp, sk })));
  log('offline ticket A: ' + ticket.length + ' chars');
  showTicketQR($('#offQr'), ticket);
  $('#offStep1').hidden = false; $('#offStep2').hidden = false;
  $('#copyTicket').onclick = () => copyText(ticket, 'Ticket copied — send it over any local channel');
  $('#showTicket').onclick = () => showTextModal('Your ticket (send it to the other device)', ticket, null);
  $('#offScan').onclick = () => startScan(text => collectChunk(text, t => acceptAnswer(t)), true);
  $('#offPaste').onclick = () => showTextModal('Paste their answer ticket', '', t => acceptAnswer(t));
  setNet('busy', 'Waiting for their answer');

  async function acceptAnswer(text) {
    try {
      const data = JSON.parse(fromUtf8(b64urlDecode(String(text).trim().replace(/^BEAM1\|/, ''))));
      if (!data.sdp || data.v !== 1) throw new Error('bad ticket');
      await S.peer.acceptAnswer(data.sdp);
      setNet('busy', 'Linking…');
      toast('Answer accepted — linking…', 'ok');
      await S.peer.waitOpen(25000);
    } catch (e) {
      setNet('err', 'Ticket rejected');
      toast('That answer did not parse — ask for it again', 'err');
      log('offline answer: ' + e.message);
    }
  }
}

async function joinOffline() {
  beginSession('receiver', 'offline');
  S.code = 'LOCAL-' + uid(6).toUpperCase();
  showScreen('pair'); showPairPanel('offline');
  $('#offStep1').hidden = true; $('#offStep2').hidden = false;
  setNet('busy', 'Scan their ticket');
  $('#offScan').onclick = () => startScan(text => collectChunk(text, t => takeOffer(t)), true);
  $('#offPaste').onclick = () => showTextModal('Paste their ticket', '', t => takeOffer(t));
  $('#copyTicket').onclick = () => toast('Scan or paste their ticket first');
  $('#showTicket').onclick = () => showTextModal('Their ticket', '', t => takeOffer(t));

  async function takeOffer(text) {
    try {
      const data = JSON.parse(fromUtf8(b64urlDecode(String(text).trim().replace(/^BEAM1\|/, ''))));
      if (!data.sdp || data.v !== 1 || data.k !== 'o') throw new Error('not an offer ticket');
      if (data.sk) S.code = 'LOCAL-' + data.sk;   // match the sender's label key
      await S.peer.init({ trickle: false, ice: ICE_LOCAL });
      await S.peer.acceptOffer(data.sdp);
      const sdp = await S.peer.createAnswer({ complete: true });
      const mine = 'BEAM1|' + b64url(utf8(JSON.stringify({ v: 1, k: 'a', sdp, sk: (S.code || '').replace(/^LOCAL-/, '') })));
      log('offline ticket B: ' + mine.length + ' chars');
      showTicketQR($('#offQr'), mine);
      $('#offQr').parentElement.hidden = false;
      $('#offStep1').hidden = false;
      $('#offStep1').querySelector('.pair-label').textContent = 'Step 2 — show this answer to the first device';
      $('#offStep2').hidden = true;
      $('#offPaste').parentElement.hidden = true;
      $('#copyTicket').onclick = () => copyText(mine, 'Answer copied — return it to the first device');
      $('#showTicket').onclick = () => showTextModal('Your answer ticket', mine, null);
      setNet('busy', 'Waiting for the first device');
      toast('Ticket read — show the answer QR now', 'ok');
      await S.peer.waitOpen(45000);
    } catch (e) {
      setNet('err', 'Ticket rejected');
      toast('That ticket did not parse — try again', 'err');
      log('offline offer: ' + e.message);
    }
  }
}

/* ── reconnection ─────────────────────────────────────────── */
async function attemptReconnect() {
  if (S.mode !== 'online' || S.reconnecting || SIG.aborted) return;
  S.reconnecting = true; S.retry++;
  if (S.retry > 4) {
    S.reconnecting = false;
    setNet('err', 'Link lost');
    toast('Link lost. Pair again to re-send — files keep their place.', 'err', 6000);
    return;
  }
  setNet('busy', `Reconnecting… (${S.retry})`);
  log('reconnect attempt ' + S.retry);
  await sleep(1200 * S.retry);
  if (SIG.aborted || S.mode !== 'online') { S.reconnecting = false; return; }
  try {
    if (S.role === 'sender') {
      await S.peer.init({ trickle: true, ice: ICE_FULL, createChannel: true });
      await SIG.post({ t: 'offer', sdp: await S.peer.createOffer() });
      const answered = await waitForAnswer(20000);
      if (!answered) throw new Error('no answer');
    } else {
      await SIG.post({ t: 'want' });
      let offer = null;
      try { offer = await waitForOfferN(S.code, 20000, -1); } catch {}
      if (!offer) throw new Error('no offer');
      await S.peer.init({ trickle: true, ice: ICE_FULL });
      await S.peer.acceptOffer(offer.sdp);
      await SIG.post({ t: 'answer', ver: offer.ver || 0, sdp: await S.peer.createAnswer() });
      await linkWait(20000);
    }
    await S.peer.waitOpen(20000);
    S.reconnecting = false; S.retry = 0;
    toast('Link restored — resuming', 'ok');
  } catch (e) {
    S.reconnecting = false;
    log('reconnect failed: ' + e.message);
    attemptReconnect();
  }
}
async function waitForAnswer(ms) {
  const t0 = now();
  while (now() - t0 < ms && !SIG.aborted) {
    for (const wrap of await SIG.poll()) {
      const m = wrap.data || wrap;
      if (m.t === 'ice' && m.c) S.peer.addIce(m.c);
      if (m.t === 'answer') {
        try { await S.peer.acceptAnswer(m.sdp); return true; } catch { return false; }
      }
    }
    await sleep(600);
  }
  return false;
}

/* ── UI wiring ────────────────────────────────────────────── */
const NET = { relay: false };

function renderCode(el, code) {
  const chunks = $$('.code-chunk', el);
  if (chunks.length === 2) { chunks[0].textContent = code.slice(0, 3); chunks[1].textContent = code.slice(3); }
  else el.textContent = code;
}
function showPairPanel(which) {
  $('#modePick').hidden = true;
  $('#pairModePanel').hidden = false;
  $('#pairOnline').hidden = which !== 'online';
  $('#pairOffline').hidden = which !== 'offline';
}
async function copyText(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg, 'ok'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg, 'ok'); } catch { toast('Copy blocked — select manually', 'err'); }
    ta.remove();
  }
}
function showTextModal(title, value, onConfirm) {
  $('#textTitle').textContent = title;
  const ta = $('#textArea'); ta.value = value; openModal('modalText');
  $('#textConfirm').onclick = () => { closeModal('modalText'); onConfirm && onConfirm(ta.value); };
  setTimeout(() => ta.focus(), 80);
}
function codeValue() { return $$('#codeInput input').map(i => i.value).join('').toUpperCase(); }
function fillCode(code) {
  $$('#codeInput input').forEach((inp, i) => { inp.value = code[i] || ''; inp.classList.toggle('filled', !!code[i]); });
}
function submitJoin() {
  const code = codeValue();
  if (code.length !== 6) { toast('Enter all 6 characters', 'err'); return; }
  joinOnline(code);
}
function setupCodeInputs() {
  const inputs = $$('#codeInput input');
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(-1);
      inp.classList.toggle('filled', !!inp.value);
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
      $('#rxStatus').textContent = '';
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !inp.value && i > 0) { inputs[i - 1].focus(); inputs[i - 1].value = ''; inputs[i - 1].classList.remove('filled'); }
      if (e.key === 'Enter') submitJoin();
    });
    inp.addEventListener('paste', e => {
      const raw = e.clipboardData.getData('text') || '';
      const url = /[?&]j=([A-Z0-9]{6})/i.exec(raw);
      const code = (url ? url[1] : raw.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 6).toUpperCase();
      if (!code) return;
      e.preventDefault(); fillCode(code);
      const next = inputs[Math.min(code.length, 5)]; next && next.focus();
    });
  });
}
const joinUrl = code => location.origin + '/?j=' + code;
function resetPanes() {
  SIG.aborted = true; stopHeartbeat();
  $('#modePick').hidden = false;
  $('#pairModePanel').hidden = true;
  $('#pairOnline').hidden = true;
  $('#pairOffline').hidden = true;
  $('#offQr').parentElement.hidden = false;
  $('#offStep1').hidden = false;
  $('#offStep2').hidden = false;
  const l = $('#offStep1 .pair-label'); if (l) l.textContent = 'Step 1 — show this to the other device';
  $('#offPaste').parentElement.hidden = false;
}
function setupNav() {
  $$('[data-nav]').forEach(el => el.addEventListener('click', e => {
    e.preventDefault();
    const to = el.dataset.nav;
    if (to === 'home') {
      if (screen() === 'session') return leaveSession('Session closed');
      showScreen('home'); resetPanes(); return;
    }
    resetPanes(); showScreen(to);
  }));
  $$('[data-close]').forEach(el => el.addEventListener('click', () => closeModal(el.closest('.modal').id)));
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); }));
  $('#goSend').onclick = () => { resetPanes(); showScreen('send'); };
  $('#goReceive').onclick = () => { resetPanes(); showScreen('receive'); };
  $('#joinBtn').onclick = submitJoin;
  $$('#modePick .mode-card').forEach(c => c.onclick = () => c.dataset.mode === 'online' ? hostOnline() : hostOffline());
  $('#copyCode').onclick = () => copyText(SIG.code || '', 'Code copied');
  $('#copyLink').onclick = () => copyText(joinUrl(SIG.code || ''), 'Link copied — open it on the other device');
  $('#showQr').onclick = () => {
    const url = joinUrl(SIG.code || '');
    drawQR($('#joinQr'), url);
    $('#qrLinkText').textContent = url;
    openModal('modalQr');
  };
  $('#rxScan').onclick = () => startScan(text => {
    const m = /[?&]j=([A-Z0-9]{6})/i.exec(text);
    const code = (m ? m[1] : text.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 6).toUpperCase();
    if (code.length !== 6) { toast('QR did not contain a pair code', 'err'); return; }
    fillCode(code); submitJoin();
  });
  $('#rxOffline').onclick = joinOffline;
  $('#leaveBtn').onclick = () => leaveSession('Session ended');
  $('#clearDone').onclick = () => {
    for (const id of [...S.order]) {
      const it = S.items.get(id);
      if (it && it.state === 'done') {
        S.items.delete(id); S.order.splice(S.order.indexOf(id), 1);
        const el = $(`.item[data-id="${id}"]`); el && el.remove();
      }
    }
    updQueueChrome();
  };
  $('#saveAll').onclick = saveAll;
  $('#qrLinkText').onclick = () => copyText($('#qrLinkText').textContent, 'Link copied');
}
function setupDrop() {
  const drop = $('#drop');
  drop.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (screen() === 'session' && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', e => {
    if (screen() !== 'session') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const files = [];
    if (e.clipboardData) {
      for (const it of e.clipboardData.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
      if (!files.length) {
        const text = e.clipboardData.getData('text/plain');
        if (text) files.push(new File([text], 'pasted-text.txt', { type: 'text/plain' }));
      }
    }
    if (files.length) { addFiles(files); toast('Pasted into the beam', 'ok'); }
  });
}
function setupInstall() {
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => {
    if (!deferred) { toast('Use your browser menu → “Add to Home screen”'); return; }
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null; $('#installBtn').hidden = true;
    if (outcome === 'accepted') toast('Installed — now it works fully offline', 'ok');
  };
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Installed 🎉', 'ok'); });
}

/* ── boot ─────────────────────────────────────────────────── */
function boot() {
  setupNav(); setupCodeInputs(); setupDrop(); setupInstall();
  $('#queueEmpty').hidden = false;

  const m = /[?&]j=([A-Z0-9]{6})/i.exec(location.search);
  if (m) {
    showScreen('receive'); fillCode(m[1].toUpperCase());
    setTimeout(submitJoin, 300);
  }
  const upd = () => setNet('', navigator.onLine ? 'P2P engine ready' : 'Offline — local mode ready');
  window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
  window.addEventListener('pagehide', () => { try { SIG.post({ t: 'cancel' }, true); } catch {} });
  window.addEventListener('beforeunload', () => { try { SIG.post({ t: 'cancel' }, true); } catch {} });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => log('offline shell cached')).catch(e => log('sw: ' + e.message));
  }
  log('BEAM ready · ' + deviceName());
  log('secure context: ' + (window.isSecureContext ? 'yes' : 'NO — plain http limits the link'));

  /* inspection handle (used by the automated test suite) */
  window.beamDebug = {
    S, SIG, stats,
    state: () => ({
      screen: screen(), role: S.role, mode: S.mode, code: S.code, active: S.active,
      items: [...S.items.values()].map(i => ({ id: i.id, name: i.name, dir: i.dir, size: i.size, sent: i.sent, recv: i.recv, state: i.state, mode: i.mode }))
    }),
    link: async () => {
      try {
        const pc = S.peer.pc; if (!pc) return null;
        const st = await pc.getStats();
        for (const r of st.values()) {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated !== false) {
            let l = '', rem = '';
            for (const c of st.values()) {
              if (c.id === r.localCandidateId) l = (c.candidateType || '') + '/' + (c.protocol || '');
              if (c.id === r.remoteCandidateId) rem = (c.candidateType || '') + '/' + (c.protocol || '');
            }
            return { local: l, remote: rem, bytesSent: r.bytesSent, bytesReceived: r.bytesReceived };
          }
        }
      } catch {}
      return null;
    }
  };
}
document.addEventListener('DOMContentLoaded', boot);
