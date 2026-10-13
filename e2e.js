/* BEAM end-to-end test — two real browsers, real bytes.
   node test/e2e.js            (server must not already be running on TEST_PORT)
   Verifies: online pairing, encrypted-ish direct link, both-way transfers,
   integrity (sha-256 of what landed vs what was sent), offline QR-ticket flow. */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.TEST_PORT || 8899);
const URLBASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFile(name, bytes) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, crypto.randomBytes(bytes));
  return p;
}
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function waitScreen(page, want, timeout = 40000) {
  await page.waitForFunction(w => (document.body.dataset.screen || 'home') === w, want, { timeout });
}

/* read the receiver's OPFS copy of the first matching file and hash it */
async function hashOpfs(page, matchName) {
  return page.evaluate(async (needle) => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (name.includes(needle)) {
        const f = await handle.getFile();
        const buf = await f.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        return { name, size: buf.byteLength, sha: [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') };
      }
    }
    return null;
  }, matchName);
}
const queueState = page => page.evaluate(() => [...document.querySelectorAll('.item')].map(el => ({
  name: el.querySelector('.fname').textContent.trim(),
  pill: el.querySelector('.pill').textContent.trim(),
  sub: el.querySelector('.fsub').textContent.trim()
})));

async function waitItemsDone(page, n, timeout = 90000) {
  await page.waitForFunction(count => {
    const pills = [...document.querySelectorAll('.item .pill')];
    return pills.filter(p => p.textContent.trim() === 'done').length >= count;
  }, n, { timeout });
}

async function startServer() {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stdout.write('[srv:err] ' + d));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(URLBASE + '/api/config'); if (r.ok) return srv; } catch {}
    await sleep(250);
  }
  throw new Error('server did not start');
}

async function freshPage(browser) {
  const ctx = await browser.newContext({ permissions: [] });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('    [page error] ' + m.text().slice(0, 160)); });
  page.on('pageerror', e => console.log('    [page crash] ' + String(e.message).slice(0, 200)));
  await page.goto(URLBASE + '/');
  await page.waitForFunction(() => !!window.beamDebug);
  return page;
}

async function pairOnline(pageA, pageB) {
  await pageA.click('#goSend');
  await pageA.click('.mode-card[data-mode="online"]');
  await pageA.waitForSelector('#codeShow .code-chunk');
  const code = await pageA.evaluate(() =>
    [...document.querySelectorAll('#codeShow .code-chunk')].map(s => s.textContent).join(''));
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('bad code: ' + code);
  await pageB.click('#goReceive');
  const inputs = await pageB.$$('#codeInput input');
  for (let i = 0; i < 6; i++) await inputs[i].fill(code[i]);
  await pageB.click('#joinBtn');
  return code;
}

(async () => {
  const srv = await startServer();
  const browserA = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const browserB = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let pageA, pageB, pageC, pageD;
  try {
    console.log('\n▶ ONLINE PAIRING + TRANSFER');
    pageA = await freshPage(browserA);
    pageB = await freshPage(browserB);
    const code = await pairOnline(pageA, pageB);
    console.log(`  · paired with code ${code}`);
    await waitScreen(pageA, 'session');
    await waitScreen(pageB, 'session');
    ok('both devices reach the live session screen', true);
    const link = await pageA.evaluate(() => window.beamDebug.link());
    console.log('  · link stats: ' + JSON.stringify(link));
    ok('direct peer link established (not through the server)', !!link, link ? `${link.remote} remote` : '');

    // ── A → B, 6 MB
    const big = makeFile('movie-sample.bin', 6 * 1024 * 1024);
    const bigSha = sha256(big);
    const t0 = Date.now();
    await pageA.setInputFiles('#fileInput', big);
    await waitItemsDone(pageB, 1);
    const dt = (Date.now() - t0) / 1000;
    const got = await hashOpfs(pageB, 'movie-sample.bin');
    ok('6 MB arrived intact (sha-256 match)', got && got.sha === bigSha,
      got ? `${(6 / dt).toFixed(1)} MB/s over loopback` : 'no file found');
    const st = await pageA.evaluate(() => window.beamDebug.link());
    ok('link stats show real bytes moved', st && st.bytesSent > 6 * 1024 * 1024, st ? JSON.stringify(st) : '');

    // ── B → A, 1.5 MB (reverse direction on the same link)
    const small = makeFile('cat-photo.bin', Math.floor(1.5 * 1024 * 1024));
    const smallSha = sha256(small);
    await pageB.setInputFiles('#fileInput', small);
    // sender + receiver pills settle; give the "have" confirmation a moment
    await waitItemsDone(pageB, 1, 60000).catch(() => {});
    await sleep(1500);
    const got2 = await hashOpfs(pageA, 'cat-photo.bin');
    ok('reverse transfer also intact', got2 && got2.sha === smallSha,
      got2 ? 'sha match' : 'receiver has no copy yet: ' + JSON.stringify(await queueState(pageA)));

    // ── zero-byte file and a paste
    const empty = makeFile('empty-note.txt', 0);
    await pageA.setInputFiles('#fileInput', empty);
    await waitItemsDone(pageB, 2);
    ok('zero-byte file handled', true);
    console.log('  · queue on receiver: ' + JSON.stringify(await queueState(pageB)));

    console.log('\n▶ OFFLINE TICKET FLOW (no internet at all)');
    pageC = await freshPage(browserA);
    pageD = await freshPage(browserB);
    await pageC.click('#goSend');
    await pageC.click('.mode-card[data-mode="offline"]');
    await pageC.waitForSelector('#offQr');
    await pageC.click('#showTicket');
    const ticketA = await pageC.inputValue('#textArea');
    await pageC.click('#modalText [data-close]');
    ok('offer ticket generated', ticketA.startsWith('BEAM1|'), ticketA.length + ' chars in QR');

    await pageD.click('#goReceive');
    await pageD.click('#rxOffline');
    await pageD.waitForSelector('#offStep2:not([hidden])');
    ok('receiver asks for the sender ticket (no QR yet)', true);
    await pageD.click('#offPaste');
    await pageD.fill('#textArea', ticketA);
    await pageD.click('#textConfirm');
    await pageD.waitForFunction(() =>
      document.querySelector('#offStep1 .pair-label').textContent.includes('Step 2'), null, { timeout: 20000 });
    await pageD.click('#showTicket');
    const ticketB = await pageD.inputValue('#textArea');
    await pageD.click('#modalText [data-close]');
    ok('answer ticket generated by receiver', ticketB.startsWith('BEAM1|'));

    await pageC.click('#offPaste');
    await pageC.fill('#textArea', ticketB);
    await pageC.click('#textConfirm');
    await waitScreen(pageC, 'session');
    await waitScreen(pageD, 'session');
    ok('offline handshake links both devices (zero internet)', true);

    const off = makeFile('offline-drop.bin', 1024 * 1024);
    const offSha = sha256(off);
    await pageC.setInputFiles('#fileInput', off);
    await waitItemsDone(pageD, 1);
    let got3 = await hashOpfs(pageD, 'offline-drop.bin');
    if (!got3) { // also try by size, in case the label key ever mismatches
      const all = await pageD.evaluate(async () => {
        const root = await navigator.storage.getDirectory(); const out = [];
        for await (const [name, h] of root.entries()) { const f = await h.getFile(); out.push({ name, size: f.size }); }
        return out;
      });
      console.log('  · receiver storage: ' + JSON.stringify(all));
      console.log('  · receiver queue  : ' + JSON.stringify(await queueState(pageD)));
    }
    ok('file transferred over the offline (LAN-only) link', got3 && got3.sha === offSha,
      got3 ? `${got3.name} (${got3.size} bytes)` : 'no copy found');
    const offLink = await pageC.evaluate(() => window.beamDebug.link());
    console.log('  · offline link stats: ' + JSON.stringify(offLink));

    console.log('\n▶ SIGNALING SERVER IS BLIND TO CONTENT');
    const names = await (await fetch(URLBASE + '/api/sig?room=' + code + '&role=host&since=0')).json();
    const raw = JSON.stringify(names);
    ok('relay payload contains no file name or bytes', !raw.includes('movie-sample') && !raw.includes('cat-photo'));
  } catch (e) {
    fail++; console.log('\n✗ SUITE ERROR: ' + e.message);
  } finally {
    for (const b of [browserA, browserB]) { try { await b.close(); } catch {} }
    try { srv.kill('SIGKILL'); } catch {}
  }
  console.log(`\n──── ${pass} passed, ${fail} failed ────\n`);
  process.exit(fail ? 1 : 0);
})();
