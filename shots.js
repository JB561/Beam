/* Visual QA — screenshots of every screen with live data */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8877, BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', 'docs', 'screens');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} await sleep(250); }

  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const phone = await b.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const desk = await b.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
  const pA = await phone.newPage(), pB = await desk.newPage();
  await pA.goto(BASE + '/'); await pB.goto(BASE + '/');
  await pA.waitForFunction(() => !!window.beamDebug); await pB.waitForFunction(() => !!window.beamDebug);
  await sleep(900);

  const shot = (pg, name) => pg.screenshot({ path: path.join(OUT, name + '.png') });
  await shot(pA, '1-home-mobile');
  await shot(pB, '1-home-desktop');

  // send → mode picker
  await pA.click('#goSend'); await sleep(450); await shot(pA, '2-send-modes');

  // online pairing, then join from desktop
  await pA.click('.mode-card[data-mode="online"]');
  await pA.waitForSelector('#codeShow .code-chunk'); await sleep(1200);
  await shot(pA, '3-pair-code');
  const code = await pA.evaluate(() => [...document.querySelectorAll('#codeShow .code-chunk')].map(s => s.textContent).join(''));

  await pB.click('#goReceive'); await sleep(500);
  const inputs = await pB.$$('#codeInput input');
  for (let i = 0; i < 6; i++) await inputs[i].fill(code[i]);
  await sleep(300); await shot(pB, '4-receive-code');

  await pB.click('#joinBtn');
  await sleep(4000);
  await pA.waitForFunction(() => (document.body.dataset.screen) === 'session', null, { timeout: 30000 });
  await pB.waitForFunction(() => (document.body.dataset.screen) === 'session', null, { timeout: 30000 });
  await sleep(700);
  await shot(pA, '5-session-empty');

  // push a photo + a video-ish file and catch it mid-flight
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-shot-'));
  const img = require('child_process').execSync(`python3 - <<'PY'
from PIL import Image, ImageDraw
import random
im = Image.new('RGB',(1600,1000))
d = ImageDraw.Draw(im)
for i in range(0,1000,2):
    d.line([(0,i),(1600,i)], fill=(int(120+90*random.random()), 40+int(90*random.random()), 200))
for k in range(60):
    x,y = random.randint(0,1600), random.randint(0,1000)
    d.ellipse([x,y,x+random.randint(20,160),y+random.randint(20,160)], outline=(255,255,255), width=2)
im.save('${tmp}/sunset-render.jpg', quality=88)
PY
echo ok`);
  const vid = path.join(tmp, 'drone-clip.mp4');
  fs.writeFileSync(vid, crypto.randomBytes(64 * 1024 * 1024));
  const zip = path.join(tmp, 'project-archive.zip');
  fs.writeFileSync(zip, crypto.randomBytes(9 * 1024 * 1024));

  await pA.setInputFiles('#fileInput', [path.join(tmp, 'sunset-render.jpg'), vid, zip]);
  await sleep(650);
  await shot(pA, '6-session-sending');
  await pB.waitForFunction(() => document.querySelectorAll('.item').length >= 3, null, { timeout: 30000 }).catch(() => {});
  await sleep(1600);
  await shot(pB, '6-session-receiving');

  // overflow menu / log open
  await pB.click('.logwrap summary').catch(() => {});
  await sleep(400); await shot(pB, '7-session-details');

  // offline tickets
  const pC = await phone.newPage();
  await pC.goto(BASE + '/'); await pC.waitForFunction(() => !!window.beamDebug);
  await pC.click('#goSend'); await pC.click('.mode-card[data-mode="offline"]');
  await pC.waitForSelector('#offQr'); await sleep(900);
  await shot(pC, '8-offline-qr');

  await b.close(); srv.kill('SIGKILL');
  console.log('screens written to', OUT);
})().catch(e => {
  console.error(e);
  try { process.kill(srv.pid, 'SIGKILL'); } catch {}
  process.exit(1);
});
