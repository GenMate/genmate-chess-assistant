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
const tabSet = new Set();

// Debug logging — OFF in release. Flip DEBUG to true to print [GM-BG] logs.
const DEBUG = false;
const _bt0 = Date.now();
function btlog(label){ if (DEBUG) console.log('[GM-BG] +' + (Date.now()-_bt0) + 'ms ' + label); }

function workerSend(cmd) { if (worker) worker.postMessage(cmd); }

function startJob(job) {
  searching = false; stopSent = false;
  currentJobId = job.jobId || 0;
  // ucinewgame только при смене позиции — не сбрасываем хэш-таблицы зря
  if (job.fen !== lastJobFen) {
    workerSend('ucinewgame');
    lastJobFen = job.fen;
  }
  workerSend('setoption name MultiPV value 1');
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
  try { worker = new Worker(browser.runtime.getURL('wasm/sf-lite-worker.js')); }
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
      ['mode','movetime','showEval','token','enableHints','showFullMove']);

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
                  infinite: msg.infinite || false, jobId: msg.jobId || 0 };
    // Если тот же FEN уже считается в режиме infinite — не трогаем движок
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

browser.storage.sync.get(['token']).then(r => {
  browser.storage.sync.set({
    mode:        r.mode        || 'infinite',
    showEval:    r.showEval    !== undefined ? r.showEval    : true,
    enableHints: r.enableHints !== undefined ? r.enableHints : true,
    movetime:    r.movetime    || 3000,
    showFullMove: r.showFullMove || false,
  });
});

initEngine();
checkNews();
setInterval(checkNews, 6 * 60 * 60 * 1000);
