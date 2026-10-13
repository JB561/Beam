# BEAM for Android — true zero-network transfer

This is the strict version of the promise: **no network of any kind**. Not a hotspot, not a router,
not an internet uplink — the two phones form their own private 802.11 radio link with
**Wi-Fi Direct**, and files stream across it.

If you were hoping for *Bluetooth* specifically: Android's Bluetooth stack is capped at a few
hundred KB/s with pairing rituals and vendor-specific OPP quirks, and Google removed easy file
transfer over RFCOMM years ago. Wi-Fi Direct is the same "no infrastructure" idea, done properly —
it's what Android's own Quick Share/Nearby uses for local transfers. The browser build
(`../public/`) covers the everyday case; this covers the dead-zone case.

## What it does

* **Host a link** — creates a Wi-Fi Direct group (the phone becomes the group owner, always
  `192.168.49.1`) and listens on TCP `8988`.
* **Join a link** — discovers nearby devices, tap one, and it connects straight to the owner.
* Pick any files through the system picker; **both phones can send at the same time**.
* Incoming files land in **Downloads/Beam** (Android 10+) or the app's folder on older releases.
* Live per-file progress, byte counters and a link log on screen.

## Build it

1. Open the `android/` folder in **Android Studio** (Ladybug or newer).
2. Let Gradle sync (it will fetch the Gradle wrapper, AGP 8.5 and Kotlin 1.9 automatically).
3. **Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s)**, or from a terminal:

   ```bash
   ./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
   ```

   (No wrapper JAR is committed; run `gradle wrapper` once, or just use Android Studio.)
4. Install on both phones: `adb install app-debug.apk` — or copy the APK across and tap it.

Requires `compileSdk 34`, `minSdk 24`. Only standard AndroidX + Material + coroutines are used;
there is nothing exotic to configure.

## Using it on two phones

1. Turn on **Wi-Fi** on both phones (no connection to any network is needed — just the radio).
2. Phone A: **Host a link**. Phone B: **Join a link**, wait for the list, tap phone A.
3. The link strip turns green. Pick files on either phone — they stream across directly.
4. **Close link** tears the group down.

## Permissions, and why

| Permission | Reason |
|---|---|
| `NEARBY_WIFI_DEVICES` (13+) / `ACCESS_FINE_LOCATION` (≤12L) | required by Android to discover Wi-Fi Direct peers |
| `CHANGE_WIFI_STATE`, `ACCESS_WIFI_STATE` | form and query the direct group |
| `INTERNET` | only for plain TCP sockets on the local direct link — no server is contacted |

The app has no analytics, no network endpoints, and stores nothing outside the files you receive.

## How the transfer protocol works

Deliberately tiny so either side can be sender or receiver:

```
[4-byte header length][UTF-8 JSON header][raw file bytes]  … repeated per file
header = {"name":"clip.mp4","size":734003200}
```

* One `ServerSocket` on the group owner, one client socket from the joiner.
* Reads/writes happen on `Dispatchers.IO` with a 256 KB buffer; progress is reported at ~8 Hz.
* Sends are serialised through a `Mutex`, so queuing ten files doesn't interleave them.
* The receiver streams straight to its destination — nothing is buffered fully in memory, so file
  size is limited only by storage.

### Files

| File | Role |
|---|---|
| `MainActivity.kt` | UI, file picker, permissions, list adapters |
| `WifiDirect.kt` | `WifiP2pManager` wrapper: discovery, group, connection info |
| `Transfer.kt` | TCP server/client, wire protocol, MediaStore saving |

### Troubleshooting

* **No devices in the list** — Wi-Fi must be on; on Android 13+ allow *Nearby devices*; some
  vendors (Xiaomi/Oppo) add a second toggle in settings.
* **"Connect failed (code 3/2)"** — a stale group. Tap **Close link** on both phones and retry.
* **Transfers stall when the screen sleeps** — Wi-Fi Direct can idle; keep the screen awake or turn
  on *Stay awake* in developer options. (The web build has the same caveat in background tabs.)
