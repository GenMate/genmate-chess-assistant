// Chess Assistant by GenMate — Lite v1
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later
// https://github.com/GenMate/genmate-chess-assistant
//
// Uses common.js (loaded first by background.html): loadSettings,
// saveSettings, validateNews, DATA_COLLECTION, DISCLOSURE_VERSION.

const NEWS_URL =
  'https://raw.githubusercontent.com/GenMate/genmate-chess-assistant/main/news.json';
const NEWS_MAX_BYTES   = 16 * 1024;
const NEWS_TIMEOUT_MS  = 10 * 1000;
const NEWS_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Debug logging — OFF in release. Logs never include the token.
const DEBUG = false;
const _bt0 = Date.now();
function btlog(label){ if (DEBUG) console.log('[GM-BG] +' + (Date.now()-_bt0) + 'ms ' + label); }

// ==================== ENGINE REGISTRY ====================
// Lite and Full are bundled in the signed package. Lite remains the default.
// Only the selected engine is instantiated; Full never downloads executable code.
const ENGINES = {
  lite: {
    worker: 'wasm/sf-lite-worker.js',
    files: ['wasm/stockfish-19-lite-single.js', 'wasm/stockfish-19-lite-single.wasm'],
    label: 'Stockfish 19 Lite',
  },
  full: {
    worker: 'wasm/sf-full-worker.js',
    files: ['wasm/stockfish-19-single.js', 'wasm/stockfish-19-single.wasm'],
    label: 'Stockfish 19 Full',
  },
};
let engineChoice = 'lite';   // overwritten from storage at startup (falls back to lite)

// True if both files of the given engine are present in wasm/. Firefox may
// answer a missing packaged file with an empty "ok" response, so real content
// is required: at least ENGINE_FILE_MIN_BYTES are read, then the read stops.
const ENGINE_FILE_MIN_BYTES = 1000;
async function hasContent(url) {
  const r = await fetch(url);
  if (!r.ok || !r.body) return false;
  const reader = r.body.getReader();
  let size = 0;
  try {
    while (size < ENGINE_FILE_MIN_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
    }
  } finally { reader.cancel().catch(() => {}); }
  return size >= ENGINE_FILE_MIN_BYTES;
}
async function enginePresent(name) {
  const e = ENGINES[name];
  if (!e) return false;
  for (const f of e.files) {
    try { if (!(await hasContent(browser.runtime.getURL(f)))) return false; }
    catch (_) { return false; }
  }
  return true;
}

// ==================== ENGINE (one worker, strict ownership) ====================
// One Stockfish worker serves all Lichess tabs. Each search belongs to an
// owner {tabId, session, jobId}; output goes only to that owner. A new search
// while another runs: "stop" → wait for the old search's bestmove (its info
// lines are dropped) → start the new one. If that barrier takes over
// STOP_BARRIER_MS the worker is replaced.
// 30 s each for uciok and readyok: a slow or busy computer can take more than
// 10 s to compile the wasm, and restarting a slow start only adds load.
const START_TIMEOUT_MS = 30 * 1000;
const MAX_START_FAILS  = 3;
const STOP_BARRIER_MS  = 2000;
const RESTART_DELAY_MS = 1000;

let worker = null, workerGen = 0, sfReady = false;
let startTimer = null, startFails = 0, engineFailed = false;
let current = null;    // running search {fen, multiPv, infinite, movetime, owner}
let pending = null;    // next search, started after the barrier / readiness
let barrier = false, barrierTimer = null;
let lastFenSent = null;
let storedEngineName = '';
const tabSet = new Set();
const tabPorts = new Map();
// Consent listeners exist before engine registration and outlive its port.
const consentTabs = new Set();

function workerSend(cmd) { if (worker) worker.postMessage(cmd); }

function deliver(owner, msg) {
  if (!owner || !Number.isInteger(owner.tabId)) return;
  browser.tabs.sendMessage(owner.tabId,
    Object.assign({}, msg, { session: owner.session, jobId: owner.jobId })).catch(() => {});
}

function broadcast(msg, recipients = tabSet) {
  recipients.forEach(tid =>
    browser.tabs.sendMessage(tid, msg).catch(() => {
      tabSet.delete(tid);
      consentTabs.delete(tid);
    }));
}

// IDLE ENGINE UNLOAD
// The Full engine uses substantially more memory than Lite while loaded.
// After IDLE_UNLOAD_MS with no new search the worker is terminated to free the
// RAM; it loads again on the next analysis request.
const IDLE_UNLOAD_MS = 10 * 60 * 1000;   // 10 minutes
let idleTimer = null;
function armIdleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unloadEngine, IDLE_UNLOAD_MS);
}
function unloadEngine() {
  if (!worker) return;
  if (current || pending) { armIdleUnload(); return; }   // still busy → check again later
  killWorker();
}

function clearStartTimer() { if (startTimer) { clearTimeout(startTimer); startTimer = null; } }
function clearBarrier() { barrier = false; if (barrierTimer) { clearTimeout(barrierTimer); barrierTimer = null; } }

// Terminates the worker; callbacks of the old worker are ignored (workerGen).
function killWorker() {
  workerGen++;
  try { if (worker) worker.terminate(); } catch (_) {}
  worker = null; sfReady = false; current = null;
  clearStartTimer(); clearBarrier();
  lastFenSent = null; storedEngineName = '';
}

function initEngine() {
  if (worker || engineFailed) return;
  const gen = ++workerGen;
  btlog('initEngine gen=' + gen);
  armIdleUnload();
  let w;
  try { w = new Worker(browser.runtime.getURL((ENGINES[engineChoice] || ENGINES.lite).worker)); }
  catch (e) { btlog('worker create failed'); engineStartFailed(gen); return; }
  worker = w; sfReady = false;
  w.onmessage = ev => { if (gen === workerGen) onWorkerLine(typeof ev.data === 'string' ? ev.data : ''); };
  w.onerror = () => { if (gen === workerGen) engineStartFailed(gen); };
  startTimer = setTimeout(() => { if (gen === workerGen) engineStartFailed(gen); }, START_TIMEOUT_MS);
  workerSend('uci');
}

// Start failure or crash: terminate, retry a few times, then report to the
// owner of the waiting search. A click on the HUD resets the counter.
function engineStartFailed(gen) {
  if (gen !== workerGen) return;
  const lost = current;
  killWorker();
  if (lost && !pending) pending = lost;   // re-run the interrupted search
  startFails++;
  if (startFails >= MAX_START_FAILS) {
    engineFailed = true;
    if (pending) { deliver(pending.owner, { type: 'ENGINE_ERROR' }); pending = null; }
    return;
  }
  setTimeout(() => { if (!worker && (pending || tabSet.size)) initEngine(); }, RESTART_DELAY_MS);
}

function onWorkerLine(ln) {
  if (!ln) return;
  if (ln.startsWith('id name ')) {
    const words = ln.slice(8).trim().split(/\s+/)
      .filter(w => !/^[0-9a-f]{6,}$/i.test(w));
    storedEngineName = words.slice(0, 3).join(' ').replace(/[^\w .+-]/g, '').slice(0, 22);
    if (engineChoice === 'full') storedEngineName = 'Stockfish 19 Full';
    broadcast({ type: 'ENGINE_NAME', name: storedEngineName });
    return;
  }
  if (ln === 'uciok') {
    clearStartTimer();
    const gen = workerGen;
    startTimer = setTimeout(() => { if (gen === workerGen) engineStartFailed(gen); }, START_TIMEOUT_MS);
    workerSend('isready');
    return;
  }
  if (ln === 'readyok') {
    if (sfReady) return;
    clearStartTimer();
    sfReady = true;
    btlog('readyok');
    if (pending) deliver(pending.owner, { type: 'ENGINE_READY' });
    if (pending && !current) { const j = pending; pending = null; startJob(j); }
    return;
  }
  if (ln.startsWith('info ')) {
    if (barrier || !current) return;   // output of a search being stopped
    if (/\bdepth [1-9]\d*\b/.test(ln) && /\bpv [a-h][1-8][a-h][1-8]/.test(ln)) startFails = 0;
    deliver(current.owner, { type: 'ENGINE_LINE', line: ln });
    return;
  }
  if (ln.startsWith('bestmove')) {
    if (barrier) { clearBarrier(); current = null; }
    else if (current) { deliver(current.owner, { type: 'ENGINE_LINE', line: ln }); current = null; }
    if (pending && sfReady) { const j = pending; pending = null; startJob(j); }
  }
}

function startJob(job) {
  armIdleUnload();
  current = job;
  clearBarrier();
  // ucinewgame only on a position change — avoid clearing the hash needlessly
  if (job.fen !== lastFenSent) { workerSend('ucinewgame'); lastFenSent = job.fen; }
  workerSend('setoption name MultiPV value ' + job.multiPv);
  workerSend('position fen ' + job.fen);
  workerSend(job.infinite ? 'go infinite' : 'go movetime ' + job.movetime);
}

function stopCurrent() {
  if (!current || barrier) return;
  barrier = true;
  workerSend('stop');
  const gen = workerGen;
  barrierTimer = setTimeout(() => {
    if (gen !== workerGen || !barrier) return;
    btlog('stop barrier timeout → restart worker');
    killWorker();
    initEngine();
  }, STOP_BARRIER_MS);
}

function sameSearch(a, b) {
  return a.fen === b.fen && a.multiPv === b.multiPv && a.infinite === b.infinite &&
    (a.infinite || a.movetime === b.movetime);
}

function sameOwnerTab(a, b) { return !!a && !!b && a.tabId === b.tabId; }

// Queues `job` as the next search; a different tab's queued search is told
// it was displaced.
function setPending(job) {
  if (pending && job && !sameOwnerTab(pending.owner, job.owner)) deliver(pending.owner, { type: 'ENGINE_PREEMPTED' });
  pending = job;
}

function requestJob(job, retry) {
  if (retry) { startFails = 0; engineFailed = false; }
  if (engineFailed) return { ok: false, error: 'engine' };
  armIdleUnload();
  if (!worker) initEngine();
  if (engineFailed) return { ok: false, error: 'engine' };
  if (current && !barrier) {
    // The same search is still running: just hand it to the new owner.
    if (sameSearch(current, job)) {
      if (!sameOwnerTab(current.owner, job.owner)) deliver(current.owner, { type: 'ENGINE_PREEMPTED' });
      current.owner = job.owner;
      setPending(null);
      return { ok: true, ready: sfReady };
    }
    if (!sameOwnerTab(current.owner, job.owner)) deliver(current.owner, { type: 'ENGINE_PREEMPTED' });
    setPending(job);
    stopCurrent();
    return { ok: true, ready: sfReady };
  }
  if (current || !sfReady) { setPending(job); return { ok: true, ready: sfReady }; }
  startJob(job);
  return { ok: true, ready: true };
}

// Stops searches of one owner tab (optionally only a given session).
function stopOwner(tabId, sessionId, jobId) {
  const match = o => o && o.tabId === tabId && (sessionId === undefined || o.session === sessionId) &&
    (jobId === undefined || o.jobId === jobId);
  if (pending && match(pending.owner)) pending = null;
  if (current && !barrier && match(current.owner)) stopCurrent();
}

function stopAll() {
  pending = null;
  if (current && !barrier) stopCurrent();
}

// ==================== DATA CONSENT ====================
// Firefox 140+ keeps the decision as an optional data_collection permission
// (source of truth: permissions.contains). Older Firefox has no such API; the
// decision is then the local record written by consent.html. Any error reads
// as "not granted" — nothing is sent without a positive answer.
async function readConsentRecord() {
  const r = await browser.storage.local.get(['consent']);
  const c = r && r.consent;
  return (c && typeof c === 'object' && c.v === DISCLOSURE_VERSION && typeof c.game === 'boolean') ? c : null;
}

async function supportsDataCollection() {
  const all = await browser.permissions.getAll();   // throws → caller fails closed
  return !!all && typeof all === 'object' && 'data_collection' in all;
}

async function getConsent() {
  let modern;
  try { modern = await supportsDataCollection(); }
  catch (_) { return { state: 'error', modern: null }; }
  let record = null;
  try { record = await readConsentRecord(); }
  catch (_) { return { state: 'error', modern }; }
  if (modern) {
    let granted = false;
    try { granted = await browser.permissions.contains({ data_collection: DATA_COLLECTION }); }
    catch (_) { return { state: 'error', modern }; }
    if (granted) return { state: 'granted', modern };
    return { state: record ? 'denied' : 'undecided', modern };
  }
  if (!record) return { state: 'undecided', modern };
  return { state: record.game ? 'granted' : 'denied', modern };
}

function consentChanged() {
  stopAll();
  broadcast({ type: 'CONSENT_CHANGED' }, new Set([...tabSet, ...consentTabs]));
}

function openConsentTab() {
  return browser.tabs.create({ url: browser.runtime.getURL('consent.html'), active: true });
}

// After install or update: open the data settings tab once, unless a
// decision for the current disclosure already exists.
async function onInstalled(details) {
  if (!details || (details.reason !== 'install' && details.reason !== 'update')) return;
  let shown = false;
  try { shown = (await browser.storage.local.get(['consentShown'])).consentShown === DISCLOSURE_VERSION; }
  catch (_) { shown = false; }
  if (shown) return;
  const c = await getConsent();
  let decided = false;
  try { decided = !!(await readConsentRecord()); } catch (_) { decided = false; }
  if (c.state === 'granted' || decided) return;
  try { await openConsentTab(); } catch (_) { return; }
  try { await browser.storage.local.set({ consentShown: DISCLOSURE_VERSION }); } catch (_) {}
}

// ==================== NEWS ====================
// Enabled by default. Requests carry no token, game or browsing data (no cookies).
let newsTimer = null, newsCtrl = null, newsBusy = null;
function startNews() {
  if (newsTimer) return;
  newsTimer = setInterval(checkNews, NEWS_INTERVAL_MS);
  checkNews();
}

// Reads at most `limit` bytes of the body; returns null if it is larger.
async function readLimited(resp, limit, ctrl) {
  if (!resp.body || typeof resp.body.getReader !== 'function') return null;
  const reader = resp.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { ctrl.abort(); } catch (_) {} return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

function checkNews() {
  if (!newsBusy) newsBusy = fetchNews().finally(() => { newsBusy = null; });
  return newsBusy;
}

async function fetchNews() {
  const ctrl = newsCtrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NEWS_TIMEOUT_MS);
  try {
    const r = await fetch(NEWS_URL, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: ctrl.signal,
    });
    if (!r.ok) return;
    const text = await readLimited(r, NEWS_MAX_BYTES, ctrl);
    if (text === null) return;
    let raw; try { raw = JSON.parse(text); } catch (_) { return; }
    const news = validateNews(raw);
    if (!news) return;
    const st = await browser.storage.local.get(['notifiedNewsId', 'seenNewsId']);
    await browser.storage.local.set({ pendingNews: news });
    const notified = st.notifiedNewsId || st.seenNewsId;
    if (notified === news.id) return;
    // System notification once per news id; the popup plate stays until ×.
    await browser.storage.local.set({ notifiedNewsId: news.id });
    await browser.notifications.create('gm', {
      type: 'basic', iconUrl: browser.runtime.getURL('icons/icon48.png'),
      title: 'GenMate: ' + news.title, message: news.body,
    });
  } catch (_) {
    // News failure never blocks analysis or displays a modal error.
  } finally {
    clearTimeout(timer);
    if (newsCtrl === ctrl) newsCtrl = null;
  }
}

// Unread news for the popup plate (validated again: may come from 1.1.0).
async function getNewsForPopup() {
  const r = await browser.storage.local.get(['pendingNews', 'dismissedNewsId', 'seenNewsId']);
  const news = validateNews(r.pendingNews);
  if (!news) return { news: null };
  if (news.id === r.dismissedNewsId || news.id === r.seenNewsId) return { news: null };
  return { news };
}

async function dismissNews(id) {
  const r = await browser.storage.local.get(['pendingNews']);
  const news = validateNews(r.pendingNews);
  if (!news || news.id !== id) return { ok: false };
  await browser.storage.local.set({ dismissedNewsId: id });
  return { ok: true };
}

async function onNotificationClicked(id) {
  if (id !== 'gm') return;
  try {
    const r = await browser.storage.local.get(['pendingNews']);
    const news = validateNews(r.pendingNews);
    if (news && news.url) await browser.tabs.create({ url: news.url });
  } catch (_) {}
}

// ==================== MESSAGES ====================
// Who is talking: an extension page (popup.html / consent.html) or the content
// script in a https://lichess.org tab. Anything else is ignored.
function isLichessUrl(u) {
  try { const p = new URL(u); return p.protocol === 'https:' && p.hostname === 'lichess.org'; }
  catch (_) { return false; }
}
function senderInfo(sender) {
  if (!sender || sender.id !== browser.runtime.id) return null;
  const base = browser.runtime.getURL('');
  const surl = typeof sender.url === 'string' ? sender.url : '';
  if (surl.startsWith(base)) return { kind: 'page', page: surl.slice(base.length).split(/[?#]/)[0] };
  const tab = sender.tab;
  if (tab && Number.isInteger(tab.id) && tab.id >= 0 && isLichessUrl(tab.url || surl)) {
    return { kind: 'content', tabId: tab.id };
  }
  return null;
}

const FEN_RE = /^[1-8pnbrqkPNBRQK]{1,8}(\/[1-8pnbrqkPNBRQK]{1,8}){7} [wb] (-|[KQkq]{1,4}) (-|[a-h][36]) \d{1,4} \d{1,4}$/;
function isInt(x, lo, hi) { return Number.isInteger(x) && x >= lo && x <= hi; }

function parseJob(msg, tabId) {
  if (typeof msg.fen !== 'string' || !FEN_RE.test(msg.fen)) return null;
  if (!isInt(msg.session, 1, Number.MAX_SAFE_INTEGER) || !isInt(msg.jobId, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof msg.infinite !== 'boolean') return null;
  if (!isInt(msg.multiPv, 1, 3) || !isInt(msg.movetime, 100, 300000)) return null;
  return {
    fen: msg.fen, infinite: msg.infinite, multiPv: msg.multiPv, movetime: msg.movetime,
    owner: { tabId, session: msg.session, jobId: msg.jobId },
  };
}

function onMessage(msg, sender) {
  const who = senderInfo(sender);
  if (!who || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const fromPage = who.kind === 'page';
  const fromContent = who.kind === 'content';
  const settingsPage = fromPage && (who.page === 'consent.html' || who.page === 'popup.html');

  switch (msg.type) {
    // ---- engine ----
    case 'ENGINE_REGISTER':
      if (fromContent) tabSet.add(who.tabId);
      if (!fromContent && !fromPage) return;
      if (!engineFailed) initEngine();
      return Promise.resolve({ ready: sfReady, engineName: storedEngineName });
    case 'ENGINE_STATUS':
      return Promise.resolve({ ready: sfReady, engineName: storedEngineName, failed: engineFailed });
    case 'ENGINE_ANALYZE': {
      if (!fromContent) return;
      const job = parseJob(msg, who.tabId);
      if (!job) return Promise.resolve({ ok: false, error: 'bad-message' });
      tabSet.add(who.tabId);
      return Promise.resolve(requestJob(job, msg.retry === true));
    }
    case 'ENGINE_STOP':
      if (!fromContent || !isInt(msg.session, 1, Number.MAX_SAFE_INTEGER) || !isInt(msg.jobId, 1, Number.MAX_SAFE_INTEGER)) return;
      stopOwner(who.tabId, msg.session, msg.jobId);
      return Promise.resolve({ ok: true });
    case 'ENGINE_SWITCH': {
      // Popup only: hot-swap between Lite and the optional Full engine.
      if (who.page !== 'popup.html') return;
      const next = ENGINES[msg.engine] ? msg.engine : 'lite';
      return enginePresent(next).then(async ok => {
        if (!ok) return { ok: false, error: 'unavailable', engine: engineChoice };
        if (next !== engineChoice) {
          const previous = engineChoice;
          engineChoice = next;
          try { await saveSettings({ engine: engineChoice }); }
          catch (_) { engineChoice = previous; return { ok: false, error: 'storage', engine: previous }; }
          const resume = pending || current;
          stopAll();
          killWorker();
          pending = resume;
          startFails = 0; engineFailed = false;
          initEngine();
        }
        return { ok: true, engine: engineChoice, label: ENGINES[engineChoice].label };
      });
    }
    case 'GET_ENGINE':
      if (!fromPage) return;
      return enginePresent('full').then(fullAvailable => ({ engine: engineChoice, label: ENGINES[engineChoice].label, fullAvailable }));

    // ---- consent ----
    case 'CONSENT_GET':
      if (fromContent) consentTabs.add(who.tabId);
      return getConsent();
    case 'OPEN_CONSENT':
      if (!fromContent && !fromPage) return;
      return openConsentTab().then(() => ({ ok: true }), () => ({ ok: false }));
    case 'CONSENT_SET':
      // Only the data settings page may record a decision.
      if (who.page !== 'consent.html' || typeof msg.game !== 'boolean') return;
      // storage.onChanged then tells every tab (consentChanged).
      return browser.storage.local.set({ consent: { v: DISCLOSURE_VERSION, game: msg.game, at: Date.now() } })
        .then(() => ({ ok: true }), () => ({ ok: false }));
    // ---- token ----
    case 'TOKEN_CLEARED':
      // Popup: the user removes the token — stop using it in every tab now.
      if (who.page !== 'popup.html') return;
      broadcast({ type: 'TOKEN_CLEARED' });
      return Promise.resolve({ ok: true });

    // ---- news ----
    case 'GET_NEWS':
      if (!fromPage) return;
      return getNewsForPopup().catch(() => ({ news: null }));
    case 'DISMISS_NEWS':
      if (!fromPage || typeof msg.id !== 'string') return;
      return dismissNews(msg.id).catch(() => ({ ok: false }));
  }
}

// ==================== LISTENERS ====================
browser.tabs.onRemoved.addListener(tid => {
  consentTabs.delete(tid);
  tabSet.delete(tid);
  tabPorts.delete(tid);
  stopOwner(tid);
});
browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'genmate') return;
  const who = senderInfo(port.sender);
  if (!who || who.kind !== 'content') { try { port.disconnect(); } catch (_) {} return; }
  const tid = who.tabId;
  tabPorts.set(tid, port);
  tabSet.add(tid);
  port.onDisconnect.addListener(() => {
    if (tabPorts.get(tid) !== port) return;
    tabPorts.delete(tid);
    tabSet.delete(tid);
    stopOwner(tid);                 // tab closed or navigated away
    if (!tabSet.size) stopAll();
  });
});

browser.runtime.onMessage.addListener(onMessage);
browser.runtime.onInstalled.addListener(onInstalled);
browser.notifications.onClicked.addListener(onNotificationClicked);
if (browser.permissions.onAdded) browser.permissions.onAdded.addListener(() => { consentChanged(); });
if (browser.permissions.onRemoved) browser.permissions.onRemoved.addListener(() => { consentChanged(); });
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.consent) consentChanged();
});

// ==================== STARTUP ====================
// Nothing is written at startup (1.1.0 rewrote all settings to storage.sync
// here). Saved values are only read; missing ones use defaults.
(async () => {
  let s = { engine: 'lite' };
  try { s = await loadSettings(['engine']); } catch (_) {}
  engineChoice = s.engine === 'full' ? 'full' : 'lite';
  if (await enginePresent(engineChoice)) initEngine();
  else engineFailed = true;
  startNews();
})();
