# Installing BEAM

**Short answer to "does this need a database?" — no. None at all.**

There is no database, no file storage and no accounts anywhere in this project. The server's entire
memory of the world is one JavaScript `Map` that holds WebRTC pairing tickets for a few minutes:

```js
const rooms = new Map();   // code → { seq, seen, msgs: [a few KB of SDP tickets] }
```

* No signup ⇒ no user rows to keep.
* File bytes never reach the server ⇒ nothing to store, no buckets, no quotas.
* Pairing tickets are deleted when a room ends, and any room idle for 4 minutes is swept away.
* Restart the process and it is factory-fresh. **There is nothing to back up.**

The only place anything is written is *inside your own browser* on the receiving device (the file
you accepted, plus a cache of the app itself so it can run offline). That never leaves your device.

So hosting BEAM = running **one Node process**. That's the whole infrastructure bill.

---

## 1. Run it on your computer in 10 seconds

Requirements: **Node 18+** (or Docker, see §4). No `npm install` — the app has zero dependencies.

```bash
unzip beam-website.zip
cd beam
node server.js
```

```
BEAM running on port 8787
  local :  http://localhost:8787
  LAN   :  http://192.168.1.24:8787
```

Open the **LAN** address on your phone (same Wi-Fi) and the local one on your computer, then
**Send** → *Live code* on one and **Receive** → type the code on the other.

> This works with the internet completely disconnected — traffic stays inside your network. For a
> hotspot with no data plan, use **Send → Offline QR** and scan the ticket, which needs no
> rendezvous server at all.

---

## 2. Put it on the internet (so any two devices anywhere can pair)

Any tiny VPS, home server, Raspberry Pi or free-tier host works. Two rules:

1. **Serve it over HTTPS.** Browsers only allow WebRTC data channels in a secure context, so
   `http://` is fine for LAN testing but will be blocked publicly. A free TLS cert (Caddy or
   Let's Encrypt) is enough.
2. Keep the process running (systemd, Docker, pm2 — anything).

### Caddy (simplest, auto-TLS)

```caddyfile
beam.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### systemd unit

```ini
# /etc/systemd/system/beam.service
[Unit]
Description=BEAM file transfer
After=network.target

[Service]
WorkingDirectory=/opt/beam
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now beam
```

### No public server at all

Cloudflare Tunnel (or ngrok) gives you an HTTPS URL that points at your own machine — handy if you
want the app reachable but don't want to rent a box:

```bash
cloudflared tunnel --url http://localhost:8787
```

---

## 3. Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on. |
| `BEAM_ICE=local` | off | Never contact STUN. Pairing only over the local network. |

Client-side extra: append `?relay=1` to the URL to force a TURN-relay-only connection (needs TURN
servers configured in `public/app.js` → `ICE_FULL`). Useful for locked-down corporate networks.

There is no config file, no migrations, no seeding, no cache to warm.

---

## 4. Docker

```bash
docker compose up -d --build     # → http://localhost:8787
```

Or without compose:

```bash
docker build -t beam .
docker run -d -p 8787:8787 --name beam --restart unless-stopped beam
```

The image has no dependencies to install — it copies `server.js` and `public/` onto `node:20-alpine`.

---

## 5. Optional: run the test suite

Proves a transfer end-to-end between two real browsers (pairing, SHA-256 integrity on a multi-MB
file, both directions, the offline QR flow, and that the server never sees file names):

```bash
npm install            # installs playwright (dev-only)
npx playwright install chromium
npm test
```

---

## 6. Updating

Replace the folder contents and restart the process. Nothing to migrate — there is no schema and no
data. Your users' browsers pick up the new front end automatically (the service worker serves the
cached shell and refreshes it in the background).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pairing hangs at "Connecting…" | Both devices need to reach the server. Check the URL is HTTPS and the process is up. On a locked-down network append `?relay=1` (with TURN configured). |
| "Camera unavailable" when scanning | Browsers require HTTPS for camera access. Use the *Show ticket text* / copy-paste path instead — it's equivalent. |
| Link drops mid-transfer | Nothing is lost: reopen the tab, pair again and BEAM resumes from the byte where it stopped. |
| Very slow over the internet | Your NAT needs a relay (see above). On the same Wi-Fi this never applies. |
| iOS Safari pauses big transfers | Mobile browsers throttle background tabs — keep the app in the foreground while transferring. |
