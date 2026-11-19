"use strict";

// Everything here is simulated. No network requests, no navigation,
// and every "password" is just random asterisks.
const MAX_LINES = 40;
const TICK_MS = 180;

const $ = (id) => document.getElementById(id);
const logEl = $("log");

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const hex = (n) => Array.from({ length: n }, () => rand(0, 15).toString(16)).join("");
const ip = () => `${rand(11, 223)}.${rand(0, 255)}.${rand(0, 255)}.${rand(1, 254)}`;
const mask = () => "*".repeat(rand(8, 14));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOSTS = [
  "relay-eu-03.darknode.invalid", "proxy7.shadowgrid.invalid", "c2-gateway.nullroute.invalid",
  "vault-cdn.ghostnet.invalid", "exfil-ams.torbridge.invalid", "node-sg-12.blackmesh.invalid",
];

/**
 * Each category gets its own progress bar.
 * total = items per "batch"; when a bar reaches 100% it shows DONE, then starts a new batch.
 */
const CATEGORIES = [
  { key: "photos",    name: "Photos",     total: 3000, step: [20, 90],  unit: "files",
    log: (n) => [`I/MediaStore: read /storage/emulated/0/DCIM/Camera/IMG_${rand(1000, 9999)}.jpg (+${n-1} more) -> upload queue  [200 OK]`, "ok"] },
  { key: "videos",    name: "Videos",     total: 120,  step: [1, 3],    unit: "files",
    log: () => [`I/MediaStore: read /storage/emulated/0/DCIM/Camera/VID_${rand(1000, 9999)}.mp4 (${rand(8, 340)} MB) -> POST /v2/ingest  [200 OK]`, "ok"] },
  { key: "contacts",  name: "Contacts",   total: 1850, step: [10, 60],  unit: "entries",
    log: (n) => [`D/ContactsProvider: query content://com.android.contacts/raw_contacts  rows=${n}  enc=AES-256-GCM`, "warn"] },
  { key: "instagram", name: "Instagram",  total: 100,  step: [1, 5],    unit: "%", hot: true,
    log: () => [`W/com.instagram.android: sessionid + saved credentials exported  pw:${mask()}  -> relay`, "err"] },
  { key: "snapchat",  name: "Snapchat",   total: 100,  step: [1, 5],    unit: "%", hot: true,
    log: () => [`W/com.snapchat.android: login store exported  pw:${mask()}  -> relay`, "err"] },
  { key: "telegram",  name: "Telegram",   total: 100,  step: [1, 5],    unit: "%", hot: true,
    log: () => [`W/org.telegram.messenger: tgnet auth_key read  tk:${hex(10)}…  -> relay`, "err"] },
  { key: "whatsapp",  name: "WhatsApp",   total: 100,  step: [1, 4],    unit: "%", hot: true,
    log: () => [`W/com.whatsapp: msgstore.db.crypt15 + key exported  key:${hex(12)}…`, "err"] },
  { key: "facebook",  name: "Facebook",   total: 100,  step: [1, 4],    unit: "%", hot: true,
    log: () => [`W/com.facebook.katana: cookies + saved password exported  pw:${mask()}`, "err"] },
  { key: "sms",       name: "SMS / Calls", total: 2600, step: [15, 80], unit: "items",
    log: (n) => [`D/SmsProvider: query content://sms/inbox  rows=${n}  -> relay`, "warn"] },
];

const NOISE = [
  () => [`SCAN   /data/data/*  ${rand(12, 900)} objects  sha256:${hex(10)}…`, "ok"],
  () => [`AUTH   bypass token ${hex(24)}  [ACCEPTED]`, "err"],
  () => [`KEYLOG buffer flush  ${rand(40, 900)} keystrokes`, "warn"],
  () => [`CAM    frontcam stream opened  frame#${rand(1, 99999)}`, "warn"],
  () => [`GPS    lat=${(Math.random() * 180 - 90).toFixed(4)} lon=${(Math.random() * 360 - 180).toFixed(4)}  uploaded`, "net"],
  () => [`UPLOAD chunk#${rand(100, 99999)}  ${rand(2, 28)}.${rand(0, 9)} MB  ->  ${ip()}:${pick([443, 8443, 9001])}`, "net"],
  () => [`ROUTE  ${ip()} -> ${ip()} -> ${pick(HOSTS)}  ${rand(18, 240)}ms`, "net"],
];

// Simulated writes to browser cache and internal storage (nothing is really saved).
const STORAGE_WRITES = [
  () => [`D/ChromeCache: write /data/data/com.android.chrome/cache/Cache/f_${hex(6)}  ${rand(4, 900)} KB`, "warn"],
  () => [`D/IndexedDB: put chrome-profile/IndexedDB/https_${pick(HOSTS)}_0/${hex(5)}.blob  ${rand(1, 64)} KB`, "warn"],
  () => [`D/LocalStorage: commit leveldb/${hex(6)}.ldb  ${rand(1, 40)} entries`, "warn"],
  () => [`I/StorageManager: write /storage/emulated/0/.sysdata/${hex(8)}.dat  ${rand(1, 48)}.${rand(0, 9)} MB  fsync OK`, "net"],
  () => [`I/StorageManager: write /data/media/0/Android/obb/.cache/${hex(8)}.bin  ${rand(1, 32)} MB  fsync OK`, "net"],
  () => [`D/Vold: /dev/block/dm-${rand(1, 9)} wrote ${rand(100, 9000)} blocks  free=${rand(2, 30)}.${rand(0, 9)}GB`, "ok"],
];

// ---------- real browser storage (fake, bounded data only) ----------
const STORE_KEY = "prank_sim_records";
const MAX_RECORDS = 200; // ring buffer keeps the stored data small

function saveRecord(entry) {
  try {
    const old = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    const next = [...old, { t: Date.now(), id: hex(12), entry }].slice(-MAX_RECORDS);
    const json = JSON.stringify(next);
    localStorage.setItem(STORE_KEY, json);
    sessionStorage.setItem(STORE_KEY, json);
    return json.length;
  } catch (err) {
    return -1; // storage blocked or full: the prank still runs without it
  }
}

// Short repeating burst of storage writes, like a save loop.
function storageBurst() {
  const n = 200000;
  for (let i = 0; i < n; i++) {
    const [msg, cls] = pick(STORAGE_WRITES)();
    const bytes = saveRecord(msg);
    write(bytes > 0 ? `${msg}  [stored ${bytes} B]` : msg, cls);
  }
}

// ---------- "device hung" effect ----------
let isHung = false;

async function hang() {
  isHung = true;
  document.body.classList.add("hung");
  write("W/ActivityManager: ANR in com.android.systemui (Input dispatching timed out)", "err");
  // let the browser paint the dimmed "hung" state, then really block the main thread
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (let i = 0; i < 20000; i++) { console.log("Hello World"); }
  saveRecord("hang: 20000 console writes");
  const stalls = rand(3, 6);
  for (let i = 0; i < stalls; i++) {
    await sleep(rand(350, 900));
    write(`I/Choreographer: Skipped ${rand(60, 400)} frames! The application may be doing too much work on its main thread.`, "warn");
  }
  await sleep(rand(300, 900));
  document.body.classList.remove("hung");
  write("I/ActivityManager: process responding again", "ok");
  isHung = false;
}

// ---------- build the per-category rows ----------
const state = new Map();

function buildRows() {
  const wrap = $("cards");
  for (const c of CATEGORIES) {
    const row = document.createElement("div");
    row.className = `row${c.hot ? " hot" : ""}`;

    const mid = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;
    const count = document.createElement("span");
    count.className = "count";
    meta.append(name, count);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    bar.appendChild(fill);
    mid.append(meta, bar);

    const pct = document.createElement("div");
    pct.className = "pct";

    row.append(mid, pct);
    wrap.appendChild(row);
    state.set(c.key, { c, row, fill, count, pct, done: 0, resetAt: 0 });
  }
}

function paint(s) {
  const ratio = Math.min(1, s.done / s.c.total);
  s.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  s.pct.textContent = ratio >= 1 ? "DONE" : `${Math.floor(ratio * 100)}%`;
  s.count.textContent = s.c.unit === "%"
    ? (ratio >= 1 ? "shared" : "sharing…")
    : `${Math.min(s.done, s.c.total).toLocaleString()}/${s.c.total.toLocaleString()}`;
  s.row.classList.toggle("done", ratio >= 1);
}

function advance(s) {
  const n = rand(s.c.step[0], s.c.step[1]);
  s.done = Math.min(s.c.total, s.done + n);
  if (Math.random() < 0.5) write(...s.c.log(n));
  if (s.done >= s.c.total) {
    write(`${s.c.name.toUpperCase()} complete  [DONE]`, "ok");
  }
  paint(s);
}

// ---------- log + routing ----------
function write(msg, cls = "") {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = `${new Date().toLocaleTimeString("en-GB")} `;
  div.append(t, document.createTextNode(msg));
  logEl.appendChild(div);
  while (logEl.children.length > MAX_LINES) logEl.removeChild(logEl.firstChild);
}

function addHop() {
  const hops = $("hops");
  const d = document.createElement("div");
  d.textContent = `› hop ${rand(1, 14)}  ${ip()}  ${rand(8, 190)}ms`;
  hops.appendChild(d);
  while (hops.children.length > 3) hops.removeChild(hops.firstChild);
}

function fakeRedirect() {
  const url = `https://${pick(HOSTS)}/s/${hex(8)}?t=${hex(6)}`;
  write(`REDIRECT 302  ->  ${url}`, "warn");
  $("redirect").textContent = `route: ${url}`;
}

// ---------- main loop ----------
async function boot() {
  const steps = [
    ["Initializing exploit chain…", "warn"],
    [`Target fingerprint ${hex(16)}`, "ok"],
    ["Privilege escalation  [OK]", "err"],
    ["Disabling security services…", "err"],
    ["Encrypted tunnel established  [OK]", "net"],
  ];
  for (const [msg, cls] of steps) {
    write(msg, cls);
    await sleep(400);
  }
}

async function main() {
  buildRows();
  state.forEach(paint);
  await boot();
  let nextHangAt = Date.now() + rand(5000, 9000);
  for (;;) {
    const pending = [...state.values()].filter((s) => s.done < s.c.total);
    if (pending.length === 0) break;
    // advance a few random unfinished categories so bars move independently
    const picks = rand(2, 4);
    for (let i = 0; i < picks; i++) advance(pick(pending));
    if (Math.random() < 0.3) write(...pick(NOISE)());
    if (Math.random() < 0.15) addHop();
    if (Math.random() < 0.08) fakeRedirect();
    if (Math.random() < 0.1) storageBurst();
    if (Date.now() >= nextHangAt) {
      await hang();
      nextHangAt = Date.now() + rand(7000, 14000);
    }
    await sleep(TICK_MS + rand(0, 160));
  }
  await finish();
}

async function finish() {
  write("ALL TRANSFERS COMPLETE  [100%]", "ok");
  write("Closing tunnel…  wiping traces…", "warn");
  await sleep(2200);
  document.body.classList.add("blackout");
}

const tickClock = () => {
  if (isHung) return; // clock freezes while the "device" is hung
  $("clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};
tickClock();
setInterval(tickClock, 1000);
main();

