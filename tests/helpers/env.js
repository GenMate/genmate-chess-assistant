// Test helpers: load extension scripts into node:vm contexts with fake
// browser APIs, a fake DOM, a fake clock and a controllable fetch.
// Everything is synthetic: no network, no real tokens (lip_TESTTOKEN…).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const EXT = fs.existsSync(path.join(ROOT, 'manifest.json')) ? ROOT : path.join(ROOT, 'genmate-chess-assistant_1-2-0');
const src = f => fs.readFileSync(path.join(EXT, f), 'utf8');

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ---------------------------------------------------------------- clock
function makeClock(start = 1_700_000_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, every }); return id; };
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms || 1)),
    clearTimeout: id => { timers.delete(id); },
    clearInterval: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null, nid = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.at)) { next = t; nid = id; }
        if (!next) break;
        now = next.at;
        if (next.every) next.at = now + next.every; else timers.delete(nid);
        try { next.fn(); } catch (e) { clock.errors.push(e); }
        await flush();
      }
      now = target;
      await flush();
    },
    errors: [],
  };
  return clock;
}

// ---------------------------------------------------------------- storage
function makeArea(initial, opts = {}) {
  const data = Object.assign({}, initial || {});
  const area = {
    data, failGet: !!opts.failGet, failSet: !!opts.failSet, failRemove: !!opts.failRemove,
    setCalls: [], removeCalls: [], onChange: null,
    async get(keys) {
      if (area.failGet) throw new Error('storage get failed');
      const ks = keys == null ? Object.keys(data) : (Array.isArray(keys) ? keys : [keys]);
      const out = {};
      for (const k of ks) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) {
      area.setCalls.push(obj);
      if (area.failSet) throw new Error('storage set failed');
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = v; }
      if (area.onChange) area.onChange(changes);
    },
    async remove(keys) {
      area.removeCalls.push(keys);
      if (area.failRemove) throw new Error('storage remove failed');
      const changes = {};
      for (const k of [].concat(keys)) { if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; } }
      if (area.onChange && Object.keys(changes).length) area.onChange(changes);
    },
  };
  return area;
}

function makeEvent() {
  const fns = [];
  return { fns, addListener: f => fns.push(f), removeListener: f => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); }, hasListener: f => fns.includes(f) };
}

// ---------------------------------------------------------------- fake DOM
class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this._text = ''; this._listeners = {}; this.attrs = {}; this.id = ''; this.className = ''; this.title = '';
    const self = this;
    this.classList = { contains: c => String(self.className).split(/\s+/).includes(c) };
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  replaceChildren(...cs) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; this.append(...cs); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('innerHTML must not be used'); }
  get innerHTML() { throw new Error('innerHTML must not be used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML must not be used'); }
  addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
  removeEventListener(t, f) { const a = this._listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  dispatch(t, ev) { for (const f of (this._listeners[t] || []).slice()) f(Object.assign({ button: 0, isTrusted: true, preventDefault() {}, stopPropagation() {} }, ev || {})); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 100 }; }
  descendants() { const out = []; const walk = n => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    if (sel.startsWith('#')) return this.descendants().filter(n => n.id === sel.slice(1));
    return this.descendants().filter(n => n.tagName === sel.toUpperCase());
  }
  closest(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    for (let n = this; n; n = n.parentNode) if (cls && n.classList && n.classList.contains(cls)) return n;
    return null;
  }
  hasElement() { return this.descendants().some(n => n.tagName !== '#TEXT'); }
}

function makeDocument() {
  const doc = { visibilityState: 'visible', selectors: {}, _listeners: {} };
  doc.createElement = t => new FakeNode(doc, t);
  doc.createTextNode = t => { const n = new FakeNode(doc, '#text'); n._text = String(t); return n; };
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.getElementById = id => doc.documentElement.querySelector('#' + id);
  doc.querySelector = sel => {
    if (sel.startsWith('#')) return doc.documentElement.querySelector(sel);
    const v = doc.selectors[sel];
    return v === undefined ? null : v;
  };
  doc.querySelectorAll = sel => { const v = doc.querySelector(sel); return v ? [v] : []; };
  doc.contains = n => { for (let x = n; x; x = x.parentNode) if (x === doc.documentElement) return true; return false; };
  doc.addEventListener = (t, f) => { (doc._listeners[t] = doc._listeners[t] || []).push(f); };
  doc.removeEventListener = (t, f) => { const a = doc._listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); };
  doc.dispatch = (t, ev) => { for (const f of (doc._listeners[t] || []).slice()) f(ev || {}); };
  return doc;
}

// ---------------------------------------------------------------- streams
// A response whose body the test pushes chunk by chunk.
function streamResponse(status = 200, headers = {}) {
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  const res = new Response(body, { status, headers });
  const enc = new TextEncoder();
  let closed = false;
  return {
    res,
    push(text) { if (!closed) ctl.enqueue(enc.encode(text)); },
    end() { if (!closed) { closed = true; ctl.close(); } },
    fail(err) { if (!closed) { closed = true; ctl.error(err || new Error('network')); } },
    get closed() { return closed; },
  };
}

// A fake fetch: each call is recorded; `reply(call)` from the test decides the
// outcome (a streamResponse, a status, or a thrown error). Abort errors the body.
function makeFetch() {
  const calls = [];
  const f = async (url, opts = {}) => {
    const call = { url: String(url), opts, stream: null };
    calls.push(call);
    const out = await f.reply(call);
    if (out instanceof Error) throw out;
    if (typeof out === 'number') return new Response('', { status: out });
    if (out && out.res) {
      call.stream = out;
      if (opts.signal) {
        if (opts.signal.aborted) out.fail(new DOMException('aborted', 'AbortError'));
        opts.signal.addEventListener('abort', () => out.fail(new DOMException('aborted', 'AbortError')));
      }
      return out.res;
    }
    return out;
  };
  f.calls = calls;
  f.reply = () => { const s = streamResponse(); return s; };
  return f;
}

// ---------------------------------------------------------------- MutationObserver
function makeMutationObserverClass(registry) {
  return class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.target = null; registry.add(this); }
    observe(target, opts) { this.target = target; this.opts = opts; }
    disconnect() { this.target = null; registry.delete(this); }
  };
}

// ---------------------------------------------------------------- content.js
const EXT_ID = 'chess-assistant@genmate';

function loadContent(opts = {}) {
  const clock = makeClock();
  const document = makeDocument();
  const fetch = makeFetch();
  const observers = new Set();
  const local = makeArea(opts.local || {}, opts.localOpts);
  const sync = makeArea(opts.sync || {}, opts.syncOpts);
  const onMessage = makeEvent(), onChanged = makeEvent();
  const sent = [];
  const env = {
    clock, document, fetch, local, sync, sent, observers,
    consent: opts.consent || 'granted',
    bgReply: null,   // optional override (msg) => reply
  };
  local.onChange = ch => onChanged.fns.forEach(f => f(ch, 'local'));
  sync.onChange = ch => onChanged.fns.forEach(f => f(ch, 'sync'));
  const browser = {
    runtime: {
      id: EXT_ID,
      sendMessage: async msg => {
        sent.push(JSON.parse(JSON.stringify(msg)));
        if (env.bgReply) { const r = env.bgReply(msg); if (r !== undefined) return r; }
        switch (msg.type) {
          case 'CONSENT_GET': return { state: env.consent };
          case 'ENGINE_ANALYZE': return { ok: true, ready: true };
          case 'ENGINE_REGISTER': return { ready: true, engineName: 'Stockfish 19 Lite' };
          default: return { ok: true };
        }
      },
      onMessage,
      connect: () => ({ onDisconnect: makeEvent(), postMessage() {} }),
      getURL: p => 'moz-extension://test-uuid/' + p,
    },
    storage: { local, sync, onChanged },
  };
  const location = { href: opts.url || 'https://lichess.org/' };
  const sessionStore = new Map();
  const windowObj = { innerWidth: 1024, innerHeight: 768, _listeners: {},
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener(t, f) { const a = this._listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    dispatch(t, e = {}) { for (const f of (this._listeners[t] || []).slice()) f(e); },
  };
  const ctx = {
    browser, document, location, window: windowObj, console,
    fetch, URL, AbortController, TextDecoder, TextEncoder, DOMException, Response, ReadableStream,
    MutationObserver: makeMutationObserverClass(observers),
    sessionStorage: { getItem: k => (sessionStore.has(k) ? sessionStore.get(k) : null), setItem: (k, v) => sessionStore.set(k, String(v)) },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    __clock: clock,
  };
  vm.createContext(ctx);
  vm.runInContext('Date.now = () => __clock.now(); Math.random = () => 0.5;', ctx);
  vm.runInContext(src('chess.js'), ctx, { filename: 'chess.js' });
  vm.runInContext(src('common.js'), ctx, { filename: 'common.js' });
  // Places a game page in the fake DOM (round markup + board).
  env.gamePage = (markup = {}) => {
    const main = document.createElement('main'); main.className = 'round';
    const wrap = document.createElement('div'); wrap.className = 'cg-wrap orientation-white';
    const board = document.createElement('cg-board');
    wrap.appendChild(board); main.appendChild(wrap); document.body.appendChild(main);
    document.selectors['main.round'] = markup.round === false ? null : main;
    document.selectors['cg-board'] = board;
    document.selectors['main cg-board'] = board;
    if (markup.tv) document.selectors['main.round.tv-single'] = main;
    if (markup.canonical) { const l = document.createElement('link'); l.attrs.href = markup.canonical; l.href = markup.canonical; document.selectors['link[rel="canonical"]'] = l; }
    if (markup.og) { const m = document.createElement('meta'); m.attrs.content = markup.og; document.selectors['meta[property="og:url"]'] = m; }
    return { main, wrap, board };
  };
  if (opts.setup) opts.setup(env);
  vm.runInContext(src('content.js'), ctx, { filename: 'content.js' });

  Object.assign(env, {
    ctx, browser, location,
    get: expr => vm.runInContext(expr, ctx),
    toContent: (msg, sender) => {
      let r;
      for (const f of onMessage.fns) { const x = f(msg, sender || { id: EXT_ID }); if (x !== undefined) r = x; }
      return r;
    },
    hud: () => document.getElementById('gm-hint'),
    hudText: () => { const h = document.getElementById('gm-hint'); return h ? h.textContent : null; },
    hudVisible: () => { const h = document.getElementById('gm-hint'); return !!h && h.style.display !== 'none'; },
    streamCalls: () => fetch.calls.filter(c => c.url.startsWith('https://lichess.org/api/board/game/stream/')),
    fireMutations: () => { for (const o of [...observers]) if (o.target) o.cb([]); },
    setUrl: u => { location.href = u; },
  });
  return env;
}

// NDJSON helpers for Board API events.
const ev = {
  full(id, o = {}) {
    return JSON.stringify(Object.assign({
      type: 'gameFull', id,
      variant: { key: 'standard', name: 'Standard', short: 'Std' },
      white: { id: 'testuser', name: 'TestUser', rating: 1500 },
      black: { aiLevel: 3 },
      initialFen: 'startpos',
      state: { type: 'gameState', moves: '', wtime: 600000, btime: 600000, winc: 0, binc: 0, status: 'started' },
    }, o)) + '\n';
  },
  state(moves, status = 'started') {
    return JSON.stringify({ type: 'gameState', moves, wtime: 600000, btime: 600000, winc: 0, binc: 0, status }) + '\n';
  },
};

// ---------------------------------------------------------------- background.js
class FakeWorker {
  constructor(url) {
    this.url = url; this.posted = []; this.terminated = false; this.onmessage = null; this.onerror = null;
    this.auto = FakeWorker.auto; FakeWorker.instances.push(this);
  }
  postMessage(cmd) {
    this.posted.push(cmd);
    if (!this.auto || this.terminated) return;
    if (cmd === 'uci' && this.auto.uciok !== false) queueMicrotask(() => this.emit('id name Stockfish 19 Lite WASM') || this.emit('uciok'));
    if (cmd === 'isready' && this.auto.readyok !== false) queueMicrotask(() => this.emit('readyok'));
    if (cmd === 'stop' && this.auto.stopReplies !== false) queueMicrotask(() => this.emit('bestmove e2e4'));
  }
  emit(line) { if (!this.terminated && this.onmessage) this.onmessage({ data: line }); }
  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];
FakeWorker.auto = {};

function loadBackground(opts = {}) {
  const clock = makeClock();
  const fetch = makeFetch();
  const local = makeArea(opts.local || {}, opts.localOpts);
  const sync = makeArea(opts.sync || {}, opts.syncOpts);
  const onMessage = makeEvent(), onConnect = makeEvent(), onInstalled = makeEvent(), onChanged = makeEvent();
  const notifOnClicked = makeEvent(), permAdded = makeEvent(), permRemoved = makeEvent(), tabRemoved = makeEvent();
  const toTabs = [], created = [], notifications = [];
  FakeWorker.instances = [];
  FakeWorker.auto = opts.workerAuto || { uciok: true, readyok: true, stopReplies: true };
  const env = { clock, fetch, local, sync, toTabs, created, notifications, FakeWorker };
  local.onChange = ch => onChanged.fns.forEach(f => f(ch, 'local'));
  sync.onChange = ch => onChanged.fns.forEach(f => f(ch, 'sync'));
  const perms = {
    modern: opts.modern !== undefined ? opts.modern : true,
    granted: !!opts.granted, failGetAll: false, failContains: false,
  };
  env.perms = perms;
  const browser = {
    runtime: {
      id: EXT_ID, onMessage, onConnect, onInstalled,
      getURL: p => 'moz-extension://test-uuid/' + p,
    },
    tabs: {
      onRemoved: tabRemoved,
      sendMessage: async (tabId, msg) => { toTabs.push({ tabId, msg: JSON.parse(JSON.stringify(msg)) }); return undefined; },
      create: async o => { created.push(o); return { id: 99 }; },
    },
    storage: { local, sync, onChanged },
    notifications: { create: (id, o) => { notifications.push({ id, o }); return Promise.resolve(id); }, onClicked: notifOnClicked },
    permissions: {
      getAll: async () => { if (perms.failGetAll) throw new Error('getAll failed'); return perms.modern ? { origins: [], permissions: [], data_collection: perms.granted ? ['authenticationInfo', 'browsingActivity'] : [] } : { origins: [], permissions: [] }; },
      contains: async q => { if (perms.failContains) throw new Error('contains failed'); return !!(q && q.data_collection && perms.granted); },
      onAdded: permAdded, onRemoved: permRemoved,
    },
  };
  // Engine file probe for the optional full engine: present only if asked.
  fetch.reply = call => {
    if (call.url.startsWith('moz-extension://')) {
      // A missing packaged file: Firefox may answer 200 with an empty body.
      if (/stockfish-\d+-single/.test(call.url) && !opts.fullPresent) return new Response('', { status: 200 });
      return new Response('x'.repeat(2000), { status: 200 });
    }
    return opts.newsReply ? opts.newsReply(call) : 404;
  };
  const ctx = {
    browser, console, fetch, URL, AbortController, TextDecoder, TextEncoder, DOMException, Response, ReadableStream, Uint8Array,
    Worker: FakeWorker, queueMicrotask,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    __clock: clock,
  };
  vm.createContext(ctx);
  vm.runInContext('Date.now = () => __clock.now();', ctx);
  vm.runInContext(src('common.js'), ctx, { filename: 'common.js' });
  vm.runInContext(src('background.js'), ctx, { filename: 'background.js' });

  const contentSender = (tabId, url = 'https://lichess.org/game/abcdefgh') => ({ id: EXT_ID, url, tab: { id: tabId, url } });
  const pageSender = page => ({ id: EXT_ID, url: 'moz-extension://test-uuid/' + page, tab: { id: 50, url: 'moz-extension://test-uuid/' + page } });
  Object.assign(env, {
    ctx, browser, onMessage, onConnect, onInstalled, notifOnClicked, permAdded, permRemoved, tabRemoved,
    get: expr => vm.runInContext(expr, ctx),
    contentSender, pageSender,
    send: async (msg, sender) => {
      let r;
      for (const f of onMessage.fns) { const x = f(msg, sender); if (x !== undefined) r = x; }
      return r === undefined ? undefined : await r;
    },
    connectTab(tabId) {
      const port = { name: 'genmate', sender: contentSender(tabId), onDisconnect: makeEvent(), disconnect() {} };
      onConnect.fns.forEach(f => f(port));
      return { disconnect: () => port.onDisconnect.fns.forEach(f => f()) };
    },
    worker: () => FakeWorker.instances[FakeWorker.instances.length - 1],
    linesTo: tabId => toTabs.filter(t => t.tabId === tabId).map(t => t.msg),
  });
  return env;
}

// Extracts the Lichess integration surface block from content.js and runs it
// alone (with chess.js for replayPosition).
function loadSurface() {
  const code = src('content.js');
  const a = code.indexOf('// BEGIN LICHESS INTEGRATION SURFACE');
  const b = code.indexOf('// END LICHESS INTEGRATION SURFACE');
  if (a < 0 || b < a) throw new Error('surface markers not found');
  const block = code.slice(a, b);
  const ctx = { URL, console };
  vm.createContext(ctx);
  vm.runInContext(src('chess.js'), ctx, { filename: 'chess.js' });
  vm.runInContext(block, ctx, { filename: 'content.js#surface' });
  return new Proxy({}, { get: (_, k) => vm.runInContext(String(k), ctx) });
}

function loadCommon(opts = {}) {
  const local = makeArea(opts.local || {}, opts.localOpts);
  const sync = makeArea(opts.sync || {}, opts.syncOpts);
  const ctx = { browser: { storage: { local, sync } }, URL, console };
  vm.createContext(ctx);
  vm.runInContext(src('common.js'), ctx, { filename: 'common.js' });
  const api = new Proxy({}, { get: (_, k) => (k === 'local' ? local : k === 'sync' ? sync : vm.runInContext(String(k), ctx)) });
  return api;
}

// JSON round trip to compare values across vm contexts.
const J = x => JSON.parse(JSON.stringify(x));

module.exports = { EXT, src, flush, makeClock, makeDocument, makeArea, makeEvent, loadContent, loadBackground, loadSurface, loadCommon, streamResponse, ev, J, FakeWorker };
