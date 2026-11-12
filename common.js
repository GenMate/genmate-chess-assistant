// GenMate Chess Assistant — Lite v1 — shared helpers
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Loaded by every extension context (background page, popup, data settings
// page and the content script). Keep it free of side effects: only constants
// and functions, nothing runs on load.

// ==================== SETTINGS STORAGE ====================
// Since 1.1.1 all settings (including the token) are written to
// browser.storage.local only, never to storage.sync. Version 1.1.0 kept them in
// storage.sync, so reading is "local first": a key present in storage.local
// (even an empty token, which marks a removed token) wins; otherwise the old
// storage.sync value is used read-only. Nothing is ever written to sync.
const SETTINGS_KEYS = [
  'token', 'mode', 'movetime', 'enableHints', 'showEval', 'showFullMove',
  'multiPv', 'engine', 'masterMode', 'hintMode',
];
const SETTINGS_DEFAULTS = {
  token: '', mode: 'infinite', movetime: 3000, enableHints: true,
  showEval: true, showFullMove: false, multiPv: 2, engine: 'lite',
  masterMode: false, hintMode: 'origin',
};

// Reads settings. Throws if storage.local cannot be read (callers show
// "Extension storage unavailable" and never fall back to sending anything).
// A failing storage.sync read only means "no legacy values".
async function loadSettings(keys) {
  const want = Array.isArray(keys) ? keys : SETTINGS_KEYS;
  const local = await browser.storage.local.get(want);
  const missing = want.filter(k => !Object.prototype.hasOwnProperty.call(local || {}, k));
  let legacy = {};
  if (missing.length) {
    try { legacy = (await browser.storage.sync.get(missing)) || {}; } catch (_) { legacy = {}; }
  }
  const out = {};
  for (const k of want) {
    if (local && Object.prototype.hasOwnProperty.call(local, k)) out[k] = local[k];
    else if (Object.prototype.hasOwnProperty.call(legacy, k)) out[k] = legacy[k];
    else out[k] = SETTINGS_DEFAULTS[k];
  }
  return normalizeSettings(out);
}

// Type-checks every value; anything unexpected falls back to the default.
function normalizeSettings(s) {
  const d = SETTINGS_DEFAULTS, o = {};
  o.token       = typeof s.token === 'string' ? s.token.trim() : d.token;
  o.mode        = (s.mode === 'infinite' || s.mode === 'timed') ? s.mode : d.mode;
  o.movetime    = (Number.isInteger(s.movetime) && s.movetime >= 100 && s.movetime <= 300000) ? s.movetime : d.movetime;
  o.enableHints = typeof s.enableHints === 'boolean' ? s.enableHints : d.enableHints;
  o.showEval    = typeof s.showEval === 'boolean' ? s.showEval : d.showEval;
  o.showFullMove = typeof s.showFullMove === 'boolean' ? s.showFullMove : d.showFullMove;
  o.multiPv     = (s.multiPv === 1 || s.multiPv === 2 || s.multiPv === 3) ? s.multiPv : d.multiPv;
  o.engine      = (s.engine === 'lite' || s.engine === 'full') ? s.engine : d.engine;
  o.masterMode  = typeof s.masterMode === 'boolean' ? s.masterMode : d.masterMode;
  o.hintMode    = (s.hintMode === 'piece' || s.hintMode === 'origin') ? s.hintMode : d.hintMode;
  for (const k of Object.keys(o)) if (!Object.prototype.hasOwnProperty.call(s, k)) delete o[k];
  return o;
}

// Writes settings to storage.local only. Throws on failure (callers must not
// report success).
async function saveSettings(patch) {
  await browser.storage.local.set(patch);
}

// "Remove token": first the local tombstone (an empty token stops any further
// use and hides an old synced copy), then a best-effort request to delete the
// old Firefox Sync copy written by 1.1.0. Other Sync settings are left alone.
// Returns { local: true|false, sync: true|false|null } (null = not attempted).
async function removeToken() {
  try { await browser.storage.local.set({ token: '' }); }
  catch (_) { return { local: false, sync: null }; }
  try { await browser.storage.sync.remove('token'); return { local: true, sync: true }; }
  catch (_) { return { local: true, sync: false }; }
}

// ==================== DATA CONSENT ====================
// Bump DISCLOSURE_VERSION when the data description on consent.html changes in
// a way that needs a new decision.
const DISCLOSURE_VERSION = 1;
const DATA_COLLECTION = ['authenticationInfo', 'browsingActivity'];

// ==================== NEWS VALIDATION ====================
// news.json is plain text plus an optional link. A link is kept only if it is
// https, on one of these exact hosts, without credentials or a custom port.
const NEWS_HOSTS = ['lichess.org', 'github.com', 'addons.mozilla.org'];
const NEWS_KEYS = ['id', 'title', 'body', 'url'];
const NEWS_LIMITS = { id: 64, title: 80, body: 200, url: 2048 };

function safeNewsUrl(u) {
  if (typeof u !== 'string' || !u || u.length > NEWS_LIMITS.url) return null;
  let p;
  try { p = new URL(u); } catch (_) { return null; }
  if (p.protocol !== 'https:') return null;
  if (p.username || p.password || p.port) return null;
  if (!NEWS_HOSTS.includes(p.hostname)) return null;
  return p.href;
}

// Returns a clean {id, title, body, url} (url may be null) or null.
function validateNews(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  for (const k of Object.keys(n)) if (!NEWS_KEYS.includes(k)) return null;
  const { id, title, body } = n;
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
  if (typeof title !== 'string' || !title.trim() || title.length > NEWS_LIMITS.title) return null;
  if (typeof body !== 'string' || body.length > NEWS_LIMITS.body) return null;
  if (n.url !== undefined && n.url !== null && typeof n.url !== 'string') return null;
  return { id, title, body, url: safeNewsUrl(n.url) };
}

// Header-safe token text; validity and scope are checked by Lichess.
function validTokenText(token) {
  return typeof token === 'string' && /^[\x21-\x7e]+$/.test(token);
}
