// Chess Assistant by GenMate — Lite v1
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later
// https://github.com/GenMate/genmate-chess-assistant

const NEWS_URL =
  'https://raw.githubusercontent.com/GenMate/genmate-chess-assistant/main/news.json';

let worker = null, sfReady = false, searching = false;
let pendingJob = null, stopSent = false, currentJobId = 0;
let storedEngineName = '';
let lastJobFen = null;

// GENMATE — ENGINE REGISTRY (KEEP both entries).
// This public build SHIPS with the Lite engine only (small, fast to load).
// The Full NNUE engine is OPTIONAL: a user can drop the two files
//   wasm/stockfish-18-single.js  and  wasm/stockfish-18-single.wasm
// into the wasm/ folder — NO code edit needed. The popup then detects them
// and shows the engine chooser so "Strong" can be selected. Default = 'lite'.
// The full worker wrapper (sf-full-worker.js) is kept so the drop-in just works.
const ENGINE_WORKERS = {
  lite: 'wasm/sf-lite-worker.js',
  full: 'wasm/sf-full-worker.js',
};
const ENGINE_LABELS = {
  lite: 'CHESS ASSISTANT · v1 — Stockfish 18 Lite',
  full: 'CHESS ASSISTANT · v1 — Stockfish 18 (full NNUE)',
};
let engineChoice = 'lite';   // overwritten from storage at startup (falls back to lite)

// True if the given engine's files are actually present in wasm/.
async function enginePresent(name) {
  const file = name === 'full' ? 'wasm/stockfish-18-single.js'
                               : 'wasm/stockfish-18-lite-single.js';
  try { const r = await fetch(browser.runtime.getURL(file)); return r.ok; }
  catch(_) { return false; }
}
const tabSet = new Set();

// Debug logging — OFF in release. Flip DEBUG to true to print [GM-BG] logs.
const DEBUG = false;
const _bt0 = Date.now();
function btlog(label){ if (DEBUG) console.log('[GM-BG] +' + (Date.now()-_bt0) + 'ms ' + label); }

function workerSend(cmd) { if (worker) worker.postMessage(cmd); }

// IDLE ENGINE UNLOAD
// The full engine wasm holds ~108 MB of RAM resident in the background page.
// When the user stops analysing (game over, tab left idle, walked away) there is
// no reason to keep that memory locked. After IDLE_UNLOAD_MS with no new search
// we terminate the worker and free the RAM. It re-loads automatically on the
// next analysis request or on a page refresh — costing only a one-off few-second
// load. 10 minutes is the chosen balance: long enough to survive between-game
// pauses and post-game review without unloading mid-session, short enough that an
// abandoned tab does not sit on 108 MB indefinitely. Change the constant to tune.
const IDLE_UNLOAD_MS = 10 * 60 * 1000;   // 10 minutes
let idleTimer = null;
function armIdleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unloadEngine, IDLE_UNLOAD_MS);
}
function unloadEngine() {
  if (!worker) return;
  if (searching) { armIdleUnload(); return; }   // still busy → check again later
  try { worker.terminate(); } catch(_) {}
  worker = null; sfReady = false; searching = false;
  pendingJob = null; stopSent = false; storedEngineName = '';
  lastJobFen = null;
}

function startJob(job) {
  armIdleUnload();   // any new search resets the idle countdown
  searching = false; stopSent = false;
  currentJobId = job.jobId || 0;
  // ucinewgame only on a position change - avoid clearing the hash tables needlessly
  if (job.fen !== lastJobFen) {
    workerSend('ucinewgame');
    lastJobFen = job.fen;
  }
  workerSend('setoption name MultiPV value ' + (job.multiPv || 1));
  workerSend(`position fen ${job.fen}`);
  workerSend(job.infinite ? 'go infinite' : `go movetime ${job.movetime}`);
}

function broadcast(msg) {
  tabSet.forEach(tid =>
    browser.tabs.sendMessage(tid, msg).catch(() => tabSet.delete(tid)));
}

function initEngine() {
  if (worker) return;
  btlog('initEngine: creating worker');
  try { worker = new Worker(browser.runtime.getURL(ENGINE_WORKERS[engineChoice] || ENGINE_WORKERS.lite)); }
  catch(e) { btlog('initEngine: worker FAILED ' + e.message); setTimeout(initEngine, 3000); return; }

  worker.onmessage = ev => {
    const ln = typeof ev.data === 'string' ? ev.data : '';
    if (!ln) return;
    if (ln.startsWith('id name ')) {
      const words = ln.slice(8).trim().split(/\s+/)
        .filter(w => !/^[0-9a-f]{6,}$/i.test(w));
      storedEngineName = words.slice(0, 3).join(' ').slice(0, 22);
      broadcast({ type: 'ENGINE_NAME', name: storedEngineName });
      return;
    }
    if (ln === 'uciok')   { btlog('uciok'); workerSend('isready'); return; }
    if (ln === 'readyok') {
      btlog('readyok (engine ready)');
      sfReady = true;
      broadcast({ type: 'ENGINE_READY' });
      if (pendingJob) { const j = pendingJob; pendingJob = null; startJob(j); }
      return;
    }
    if (ln.startsWith('info ')) {
      searching = true;
      broadcast({ type: 'ENGINE_LINE', line: ln, jobId: currentJobId });
      return;
    }
    if (ln.startsWith('bestmove ')) {
      broadcast({ type: 'ENGINE_LINE', line: ln, jobId: currentJobId });
      if (pendingJob) { const j = pendingJob; pendingJob = null; startJob(j); }
      else            { searching = false; stopSent = false; }
    }
  };
  worker.onerror = () => {
    worker = null; sfReady = false; searching = false;
    pendingJob = null; stopSent = false;
    // If the Full engine failed to load (files missing/broken), fall back to Lite.
    if (engineChoice === 'full') { engineChoice = 'lite'; browser.storage.sync.set({ engine: 'lite' }); }
    setTimeout(initEngine, 3000);
  };
  workerSend('uci');
}

async function checkNews() {
  try {
    const r = await fetch(NEWS_URL + '?t=' + Date.now());
    if (!r.ok) return;
    const news = await r.json();
    if (!news?.id) return;
    const s = await browser.storage.local.get(['seenNewsId']);
    if (s.seenNewsId === news.id) return;
    await browser.storage.local.set({ pendingNews: news });
    browser.notifications.create('gm', {
      type: 'basic', iconUrl: browser.runtime.getURL('icons/icon48.png'),
      title: 'GenMate: ' + news.title, message: news.body || '',
    });
    browser.notifications.onClicked.addListener(id => {
      if (id === 'gm' && news.url) browser.tabs.create({ url: news.url });
    });
  } catch(_) {}
}

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'genmate') return;
  const tid = port.sender?.tab?.id;
  if (tid) tabSet.add(tid);
  port.onDisconnect.addListener(() => { if (tid) tabSet.delete(tid); });
});

browser.runtime.onMessage.addListener((msg, sender) => {
  const tid = sender.tab?.id;

  if (msg.type === 'GET_SETTINGS')
    return browser.storage.sync.get(
      ['mode','movetime','showEval','token','enableHints','showFullMove','multiPv','engine','masterMode','hintMode']);

  // GENMATE — engine hot-swap. Popup sends {engine:'lite'|'full'} when the user
  // changes the engine. We tear the current worker down and boot the chosen one.
  if (msg.type === 'ENGINE_SWITCH') {
    let next = ENGINE_WORKERS[msg.engine] ? msg.engine : 'lite';
    return enginePresent(next).then(ok => {
      if (next === 'full' && !ok) next = 'lite';   // full files absent → stay lite
      if (next !== engineChoice) {
        engineChoice = next;
        browser.storage.sync.set({ engine: engineChoice });
        try { if (worker) worker.terminate(); } catch(_) {}
        worker = null; sfReady = false; searching = false;
        pendingJob = null; stopSent = false; storedEngineName = '';
        lastJobFen = null;
        initEngine();
      }
      return { ok: true, engine: engineChoice, label: ENGINE_LABELS[engineChoice] };
    });
  }
  if (msg.type === 'GET_ENGINE')
    return Promise.resolve({ engine: engineChoice, label: ENGINE_LABELS[engineChoice] });

  if (msg.type === 'SETTINGS_CHANGED') return Promise.resolve({ ok: true });

  if (msg.type === 'ENGINE_REGISTER') {
    initEngine(); if (tid) tabSet.add(tid);
    return Promise.resolve({ ready: sfReady, engineName: storedEngineName });
  }
  if (msg.type === 'ENGINE_STATUS')
    return Promise.resolve({ ready: sfReady, engineName: storedEngineName });

  if (msg.type === 'ENGINE_ANALYZE') {
    initEngine(); if (tid) tabSet.add(tid);
    const job = { fen: msg.fen, movetime: msg.movetime || 3000,
                  infinite: msg.infinite || false, jobId: msg.jobId || 0,
                  multiPv: msg.multiPv || 1 };
    // if the same FEN is already being analysed in infinite mode - leave the engine as is
    if (searching && job.fen === lastJobFen && job.infinite) {
      return Promise.resolve({ ok: true, ready: sfReady });
    }
    if (!sfReady)       { pendingJob = job; }
    else if (searching) { pendingJob = job; if (!stopSent) { workerSend('stop'); stopSent = true; } }
    else                { startJob(job); }
    return Promise.resolve({ ok: true, ready: sfReady });
  }
  if (msg.type === 'ENGINE_STOP') {
    pendingJob = null;
    if (searching && !stopSent) { workerSend('stop'); stopSent = true; }
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'GET_NEWS')
    return browser.storage.local.get(['pendingNews']);

  if (msg.type === 'DISMISS_NEWS') {
    browser.storage.local.get(['pendingNews']).then(r => {
      if (r.pendingNews?.id) browser.storage.local.set({ seenNewsId: r.pendingNews.id });
      browser.storage.local.remove('pendingNews');
    });
    return Promise.resolve({ ok: true });
  }
});

browser.storage.sync.get(
  ['token','multiPv','engine','masterMode','hintMode',
   'mode','movetime','showEval','enableHints','showFullMove']).then(async r => {
  // Ship as Lite. Use Full only if the user has added its files to wasm/.
  const wantFull = r.engine === 'full';
  engineChoice = (wantFull && await enginePresent('full')) ? 'full' : 'lite';
  // Read existing values first, then write them back (filling only what is
  // missing with defaults). Previously these five keys were NOT read, so every
  // background restart overwrote the user's mode / seconds / eval / hints /
  // full-move with defaults. Now saved settings survive restarts.
  browser.storage.sync.set({
    mode:        r.mode        || 'infinite',
    showEval:    r.showEval    !== undefined ? r.showEval    : true,
    enableHints: r.enableHints !== undefined ? r.enableHints : true,
    movetime:    r.movetime    || 3000,
    showFullMove: r.showFullMove || false,
    multiPv:     r.multiPv      || 1,
    engine:      engineChoice,
    masterMode:  r.masterMode    || false,
    hintMode:    r.hintMode       || 'piece',
  });
  initEngine();
});

checkNews();
setInterval(checkNews, 6 * 60 * 60 * 1000);
