// GenMate Chess Assistant — Lite v1
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later

// BEGIN LICHESS INTEGRATION SURFACE
// Everything this extension assumes about lichess.org lives in this block:
// page URLs, DOM selectors, the Board API endpoint, event fields, status and
// variant lists, and the HUD texts shown when one of those assumptions breaks.
// If Lichess changes something, this block (and tests/) is the place to edit.
// Functions here are pure (no DOM access, no network) and are unit-tested in
// Node by loading exactly this block (tests/lichess-surface.test.js).

const LICHESS_HOST = 'lichess.org';
const LICHESS_STREAM_URL = 'https://lichess.org/api/board/game/stream/';

// Game pages: /game/<id> (current) and /<id> (legacy, redirected by Lichess).
// <id> is the 8-char game id or the 12-char full id (game id + player id);
// the Board API wants the 8-char game id, which is the prefix of the 12-char id.
// An optional /white or /black suffix and a trailing slash are allowed.
const GAME_PATH_RE = /^\/(game\/)?([A-Za-z0-9]{8}|[A-Za-z0-9]{12})(?:\/(?:white|black))?\/?$/;
const GAME_ID_RE = /^[A-Za-z0-9]{8}$/;

// Root paths of 8 or 12 letters/digits that are not legacy game ids
// (lila conf/routes, checked 2026-10-28, plus defensive entries). Applied only
// to the legacy /<id> form: /game/<id> is always a game id.
const LICHESS_RESERVED_ROOTS = new Set([
  'analysis', 'bookmark', 'features', 'insights', 'markdown', 'password',
  'practice', 'streamer', 'timeline', 'training',
  'tournament', 'broadcast', 'challenge', 'diagnostic', 'manifest',
  'developers', 'translation', 'InstantChess',
]);

// Known pages with a board but without the user's own game: no HUD, no
// network. Matched against the whole first path segment (/tv and /tv/...,
// but not a legacy id that merely starts with "tv").
const NON_GAME_ROOTS = new Set([
  'tv', 'analysis', 'training', 'study', 'broadcast', 'editor', 'practice',
  'streamer', 'learn', 'puzzle', 'storm', 'racer', 'streak', 'opening', '@',
  'team', 'tournament', 'swiss', 'simul', 'coach',
]);

// DOM selectors (read only; the extension never reads the position from the DOM).
const SEL_TV_SINGLE = 'main.round.tv-single';
const SEL_ROUND     = 'main.round';
const SEL_ROUND_APP = '.round__app';
const SEL_MAIN_BOARD = 'main cg-board';
const SEL_CLOCK     = '.rclock';
const SEL_CANONICAL = 'link[rel="canonical"]';
const SEL_OG_URL    = 'meta[property="og:url"]';
const SEL_BOARD     = 'cg-board';
const SEL_PIECE     = 'piece';
const SEL_BOARD_WRAP = '.cg-wrap';

// Board API event schema (only the fields this extension reads).
const LIVE_STATUSES = ['created', 'started'];
const TERMINAL_STATUSES = [
  'aborted', 'mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime',
  'cheat', 'noStart', 'unknownFinish', 'insufficientMaterialClaim', 'variantEnd',
];
const SUPPORTED_VARIANTS = ['standard', 'fromPosition'];
const AI_LEVEL_MIN = 1, AI_LEVEL_MAX = 8;

const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const INIT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Stream limits and retry policy.
const MAX_ATTEMPTS        = 12;          // shared budget of automatic requests
const BACKOFF_STEPS_MS    = [3000, 5000, 8000, 13000, 21000, 30000];
const BACKOFF_JITTER      = 0.2;         // ±20 %
const RATE_LIMIT_MIN_MS   = 60000;       // 429: wait at least 60 s
const FIRST_EVENT_MS      = 15000;       // first gameFull deadline
const IDLE_MS             = 60000;       // no bytes at all (keepalives count)
const STABLE_STREAM_MS    = 30000;       // stream running this long resets the budget
const MAX_BUFFER_BYTES    = 1024 * 1024; // each NDJSON line, including its unfinished tail
const BOARD_DEBOUNCE_MS   = 400;
const BOARD_SILENCE_MS    = 5000;        // board changed, stream silent → fast reconnect
const FAST_RECONNECT_GAP_MS = 2000;
const NAV_DEBOUNCE_MS     = 300;
const NAV_INTERVAL_MS     = 1000;
const CONFLICT_RECHECK_MS = 500;
const CONFLICT_HOLD_MS    = 2000;

// HUD texts (first line + guidance line).
const TXT_NO_TOKEN     = 'Token needed\nClick the toolbar icon to add it';
const TXT_CONSENT      = 'Allow game access to show hints\nClick to open settings';
const TXT_NOT_DETECTED = 'Game not detected on this page\nReload or update the extension';
const TXT_INCONSISTENT = 'Game information is inconsistent\nReload the page';
const TXT_CONNECTING   = 'Connecting…';
const TXT_RECONNECTING = 'Reconnecting…';
const TXT_TOKEN_BAD    = 'Token invalid or missing\nboard:play scope';
const TXT_UNAVAILABLE  = 'Game unavailable\nHints work in your own games vs computer';
const TXT_RATE_LIMIT   = 'Lichess rate limit\nRetrying in ';   // + seconds + ' s'
const TXT_LOST         = 'Connection lost\nClick to retry';
const TXT_API_CHANGED  = 'Lichess API changed\nUpdate the extension';
const TXT_VS_HUMAN     = 'Works only in games\nvs computer';
const TXT_VARIANT      = 'Only standard chess\nis supported';
const TXT_POSITION     = 'Position unavailable';
const TXT_ENG_FAILED   = 'Engine failed to start\nClick to retry';
const TXT_ENG_BUSY     = 'Engine busy in another tab\nClick to analyze here';
const TXT_STORAGE      = 'Extension storage unavailable';
const TXT_OPP_TURN     = 'Opponent thinking…';
const TXT_ANALYZING    = 'Analyzing…';
const TXT_ENG_START    = 'Engine starting…';
const TXT_ENG_ERR      = 'Extension error\nTry reloading the page';
const TXT_GAME_OVER    = 'Game over: ';   // status appended after

// Parses a page URL into the 8-char game id, or null.
function parseGameUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  let p;
  try { p = new URL(u); } catch (_) { return null; }
  if (p.protocol !== 'https:' || p.hostname !== LICHESS_HOST) return null;
  if (p.username || p.password || p.port) return null;
  const m = p.pathname.match(GAME_PATH_RE);
  if (!m) return null;
  if (!m[1] && LICHESS_RESERVED_ROOTS.has(m[2])) return null;
  return m[2].slice(0, 8);
}

function isNonGamePath(pathname) {
  const seg = String(pathname || '').split('/')[1] || '';
  return NON_GAME_ROOTS.has(seg);
}

// Decides what the page is. Input is plain data read from the DOM:
// { url, tvSingle, gameSigns, canonical, ogUrl }.
// Result kinds: 'hidden' (no HUD, no network), 'no-id' (looks like a game, id
// unknown), 'conflict' (URL and page metadata disagree), 'game' (with id).
function classifyPage(input) {
  let p;
  try { p = new URL(input.url); } catch (_) { return { kind: 'hidden' }; }
  if (p.protocol !== 'https:' || p.hostname !== LICHESS_HOST) return { kind: 'hidden' };
  if (input.tvSingle || isNonGamePath(p.pathname)) return { kind: 'hidden' };
  const urlId = parseGameUrl(input.url);
  const metaId = parseGameUrl(input.canonical) || parseGameUrl(input.ogUrl);
  if (urlId) {
    if (metaId && metaId !== urlId) return { kind: 'conflict', id: urlId, metaId };
    return { kind: 'game', id: urlId };
  }
  if (metaId) return { kind: 'game', id: metaId };
  return input.gameSigns ? { kind: 'no-id' } : { kind: 'hidden' };
}

function streamUrl(id) {
  if (typeof id !== 'string' || !GAME_ID_RE.test(id)) throw new Error('bad game id');
  return LICHESS_STREAM_URL + id;
}

// HTTP status of the stream request → what to do.
function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 429) return 'ratelimit';
  if (status >= 500 && status < 600) return 'retry';
  return 'fatal';
}

// Retry-After: delay in seconds or an HTTP date. Returns milliseconds (>= 0).
function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string') return 0;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86400) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - nowMs, 86400000)) : 0;
}

function rateLimitDelay(retryAfterMs) {
  return Math.max(RATE_LIMIT_MIN_MS, retryAfterMs || 0);
}

// failureIndex 0,1,2… → 3/5/8/13/21/30 s (then 30 s) with ±20 % jitter.
function backoffDelay(failureIndex, rand) {
  const base = BACKOFF_STEPS_MS[Math.min(Math.max(failureIndex, 0), BACKOFF_STEPS_MS.length - 1)];
  const r = typeof rand === 'number' ? rand : 0.5;
  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * r));
}

function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

function classifyStatus(status) {
  if (LIVE_STATUSES.includes(status)) return 'live';
  if (TERMINAL_STATUSES.includes(status)) return 'terminal';
  return 'unknown';
}

// Checks the gameFull fields we use. Returns null when fine, else 'schema' | 'id'.
function checkGameFull(ev, expectedId) {
  if (!isObj(ev) || ev.type !== 'gameFull') return 'schema';
  if (typeof ev.id !== 'string') return 'schema';
  if (!isObj(ev.white) || !isObj(ev.black)) return 'schema';
  if (!isObj(ev.variant) || typeof ev.variant.key !== 'string') return 'schema';
  if (typeof ev.initialFen !== 'string') return 'schema';
  if (!isObj(ev.state) || typeof ev.state.moves !== 'string' || typeof ev.state.status !== 'string') return 'schema';
  if (ev.id !== expectedId) return 'id';
  return null;
}

function checkGameState(ev) {
  if (!isObj(ev) || ev.type !== 'gameState') return 'schema';
  if (typeof ev.moves !== 'string' || typeof ev.status !== 'string') return 'schema';
  return null;
}

// A side is the Lichess AI only by structure: an integer aiLevel 1..8.
// The other side must be a user (string id, no aiLevel). Names are ignored.
function isAiSide(p) {
  return isObj(p) && Number.isInteger(p.aiLevel) && p.aiLevel >= AI_LEVEL_MIN && p.aiLevel <= AI_LEVEL_MAX;
}
function isUserSide(p) {
  return isObj(p) && typeof p.id === 'string' && p.id !== '' && p.aiLevel === undefined;
}
// → { kind: 'ai', botColor: 'w'|'b' } or { kind: 'other' }
function classifyOpponents(white, black) {
  if (isAiSide(white) && isUserSide(black)) return { kind: 'ai', botColor: 'w' };
  if (isAiSide(black) && isUserSide(white)) return { kind: 'ai', botColor: 'b' };
  return { kind: 'other' };
}

function isSupportedVariant(key) { return SUPPORTED_VARIANTS.includes(key); }

// Rebuilds the position from the game's initial FEN and its UCI move list.
// All or nothing: an invalid FEN or any rejected move gives null (never a
// partial position). Lichess may send castling as king-takes-rook
// (e1h1/e1a1/e8h8/e8a8); that is converted only when a king is on the
// from-square, so a rook move such as Re8-h8 is never rewritten.
function replayPosition(initialFen, moves) {
  if (typeof moves !== 'string') return null;
  const start = initialFen === 'startpos' ? INIT_FEN : initialFen;
  if (typeof start !== 'string') return null;
  const chess = new Chess();
  if (!chess.validate_fen(start).valid || !chess.load(start)) return null;
  const board = start.split(' ')[0];
  if ((board.match(/K/g) || []).length !== 1 || (board.match(/k/g) || []).length !== 1) return null;
  for (const tok of moves.trim().split(/\s+/).filter(Boolean)) {
    if (!UCI_MOVE_RE.test(tok)) return null;
    let uci = tok;
    const fromPiece = chess.get(uci.slice(0, 2));
    if (fromPiece && fromPiece.type === 'k') {
      if (uci === 'e1h1') uci = 'e1g1';
      else if (uci === 'e1a1') uci = 'e1c1';
      else if (uci === 'e8h8') uci = 'e8g8';
      else if (uci === 'e8a8') uci = 'e8c8';
    }
    const r = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    if (!r) return null;
  }
  return chess.fen();
}

// Parses one UCI "info" line. Returns null unless it carries a principal
// variation with finite integer depth/score and a well-formed first move.
function parseEngineInfo(line) {
  if (typeof line !== 'string' || !line.startsWith('info ')) return null;
  const t = line.trim().split(/\s+/);
  const out = { depth: null, multipv: 1, cp: undefined, mate: undefined, move: null };
  const int = s => (/^-?\d{1,9}$/.test(s || '') ? Number(s) : NaN);
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'depth') out.depth = int(t[++i]);
    else if (k === 'multipv') out.multipv = int(t[++i]);
    else if (k === 'score') {
      const kind = t[++i], v = int(t[++i]);
      if (kind === 'cp') out.cp = v; else if (kind === 'mate') out.mate = v; else return null;
    } else if (k === 'pv') { out.move = t[i + 1] || null; break; }
    else if (k === 'string') return null;
  }
  if (!Number.isInteger(out.depth) || out.depth <= 0) return null;
  if (!Number.isInteger(out.multipv) || out.multipv < 1 || out.multipv > 5) return null;
  if (out.cp !== undefined && !Number.isInteger(out.cp)) return null;
  if (out.mate !== undefined && !Number.isInteger(out.mate)) return null;
  if (!out.move || !UCI_MOVE_RE.test(out.move)) return null;
  return out;
}

// Board-change signature from the pieces' classes and positions. Transient
// classes (drag, animation, ghost) are ignored so a drag does not count.
const TRANSIENT_PIECE_CLASSES = ['dragging', 'anim', 'fading', 'ghost'];
function boardSignature(pieces) {
  const items = [];
  for (const p of pieces || []) {
    const cls = String(p.cls || '').split(/\s+/).filter(c => c && !TRANSIENT_PIECE_CLASSES.includes(c));
    if (String(p.cls || '').split(/\s+/).includes('ghost')) continue;
    items.push(cls.sort().join('.') + '@' + String(p.pos || ''));
  }
  return items.sort().join('|');
}
// END LICHESS INTEGRATION SURFACE


//  CONFIG — edit these to customise the hint box without diving deep

// Font sizes (px)
const HDR_FONT  = 15;   // engine name + depth label
const BODY_FONT = 17;   // move hint (piece + evaluation)

// Evaluation thresholds (centipawns)
// POV is always from the token-holder's perspective:
//   positive = player has advantage, negative = player is worse
// Convention: + means White better, − means Black better (standard chess)
// We flip the sign for Black so that:
//   playing as Black, a -3.96 engine score means YOU are ahead → pov = +396
const EVAL_GOOD_THRESHOLD = 62;  // pov > +62 cp  → player is clearly better → green
const EVAL_BAD_THRESHOLD  = 62;  // pov < −62 cp  → player is clearly worse  → red
                                  // between −62 and +62 cp → roughly equal   → neutral

// Brand name shown in the hint header
const BRAND_NAME = 'GenMate Chess Assistant';   // full name (English)

// Status-message typography (token needed / no game / game over)
// Hierarchy: the brand name is the primary line (larger, calm light colour);
// the guidance line is secondary (smaller, soft muted colour, not bold).
// The status colour lives mainly on the thin border accent, not the text,
// so nothing glares against the dark card.
const STATUS_NAME_FONT  = 16;        // brand name — primary line
const STATUS_TEXT_FONT  = 14;        // guidance line — secondary, slightly smaller
const CLR_STATUS_NAME    = '#86efac'; // soft green — brand name (positive, brand accent)
const CLR_STATUS_TEXT    = '#dde5ef'; // near-white slate — guidance text (clear, prominent)
const CLR_STATUS_RULE    = '#3a4660'; // thin divider line under the brand name

// Hint-box colours
const CLR_GOOD    = '#008737'; // green  — player has clear advantage
const CLR_BAD     = '#d20b2f'; // red    — player is clearly worse
const CLR_NEU     = '#17232e'; // dark neutral — roughly equal position
const CLR_GEAR    = '#60a5fa'; // blue   — gear icon (shown only when analysing)
const CLR_HDR     = '#94a3b8'; // muted  — header row text (engine name, depth)

// Border colours (match body colour family)
const BRD_GOOD    = '#22c55e'; // green border when player is winning
const BRD_WAIT    = '#0ea5e9'; // blue border while thinking
const BRD_ERR     = '#eab308'; // soft gold border on warnings — noticeable, not glaring
const BRD_INFO    = '#6366f1'; // soft indigo border — neutral guidance
const BRD_DEFAULT = '#2a3447'; // dark border — neutral / idle

// Debug logging
// Set DEBUG = true to print diagnostic logs to the console. Kept OFF in
// release. Logs never include the token.
const DEBUG = false;
function dbg(...args){ if (DEBUG) console.log('[GM-DBG]', ...args); }


// ==================== STATE ====================
let cfg = Object.assign({}, SETTINGS_DEFAULTS);
let settingsOk = false;
let settingsEpoch = 0;
let paused = false;            // HUD hidden from the popup: no analysis, stream stays
let tokenSuppressed = false;   // "Remove token" requested; never use the old token again
let engineName = '';
let notBefore = 0;             // shared 429 cooldown for this tab (never bypassed)
let genCounter = 0;
let session = null;            // the current game session (see newSession)
let conflictSince = 0;
let navTimer = null;

// One object per game identity. Everything asynchronous checks live(s) after
// each await, so nothing started for an old session can touch the HUD or send
// a request once the session is torn down.
function newSession(gameId) {
  return {
    gen: ++genCounter, gameId, closed: false,
    waiting: null,                 // 'consent' | 'token' | 'storage' while blocked
    ctrl: null, connId: 0,         // current stream request
    timers: new Map(), listeners: [],
    attempts: 0, failures: 0, lost: false, lastFastAt: 0,
    gotFull: false, lastEventAt: 0, maxPly: -1,
    allowed: false, botColor: null, playerColor: null,
    initialFen: 'startpos', moves: '', currentFen: null, moveNum: 1,
    board: { el: null, obs: null, sig: '', orient: '' },
    an: { jobId: 0, fen: null, running: false, started: false, retried: false, lines: {} },
  };
}
function live(s) { return !!s && s === session && !s.closed; }

function setTimer(s, key, fn, ms) {
  clearTimer(s, key);
  const id = setTimeout(() => { s.timers.delete(key); if (live(s)) fn(); }, ms);
  s.timers.set(key, id);
}
function clearTimer(s, key) {
  const id = s.timers.get(key);
  if (id !== undefined) { clearTimeout(id); s.timers.delete(key); }
}
function addListener(s, target, type, fn) {
  target.addEventListener(type, fn);
  s.listeners.push(() => target.removeEventListener(type, fn));
}

function send(msg) {
  try { return browser.runtime.sendMessage(msg); }
  catch (e) { return Promise.reject(e); }
}

// Cancels the stream, timers, listeners, board observer and this session's
// own engine job. The session object stays as the "current identity" until
// the page context changes, so the same game is not reconnected by itself.
function teardown(s) {
  if (!s || s.closed) return;
  stopAnalysis(s);
  s.closed = true;
  if (s.ctrl) { try { s.ctrl.abort(); } catch (_) {} s.ctrl = null; }
  for (const id of s.timers.values()) clearTimeout(id);
  s.timers.clear();
  for (const off of s.listeners) { try { off(); } catch (_) {} }
  s.listeners = [];
  if (s.board.obs) { s.board.obs.disconnect(); s.board.obs = null; }
}
function dropSession() {
  if (session) teardown(session);
  session = null;
}
// Ends the session with a final HUD message; no automatic requests follow.
function endSession(s, text, type, action) {
  if (!live(s)) return;
  teardown(s);
  setStatus(text, type, action);
}

// ==================== HUD ====================
let hintEl = null;
let hud = {};
let lastStatus = null;   // { text, type, action }
let lastResult = null;   // Last displayed lines, independent of stream/search retries.
let preferredRect = { left: null, top: 10, width: 330, height: 152, lines: 2 };
let hudGesture = null, suppressHudClick = false;
const POS_KEY = 'gm_hint_pos';
const HUD_RECT_KEY = 'gm_hint_rect_v3';

function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function injectGearStyle() {
  if (document.getElementById('gm-style')) return;
  const s = document.createElement('style');
  s.id = 'gm-style';
  s.textContent = `
@keyframes gm-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
#gm-hint,#gm-hint *{box-sizing:border-box}
#gm-hint{position:fixed;z-index:2147483647;background:#fff;color:#293530;
 border:4px solid #d98a00;border-radius:10px;
 box-shadow:0 5px 14px #0c223b40;overflow:hidden;isolation:isolate;
 font-family:Arial,system-ui,sans-serif;display:flex;flex-direction:column;text-align:left}
#gm-hud-header{display:flex;align-items:center;gap:6px;flex-shrink:0;
 padding:0 10px;background:#0c223b;cursor:move;user-select:none;touch-action:none}
#gm-engine-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;color:#60a5fa}
#gm-depth{white-space:nowrap;color:#94a3b8;font-weight:700;font-variant-numeric:tabular-nums}
#gm-hud-body{flex:1;min-height:0;padding:2px 8px;overflow:auto;user-select:text;cursor:text}
#gm-hud-body table{border-collapse:collapse;width:100%;white-space:nowrap;line-height:1.25;font-variant-numeric:tabular-nums}
#gm-hud-body td{vertical-align:middle}
#gm-hud-status{flex-shrink:0;padding:2px 26px 2px 8px;
 background:#0c223b;color:#dde5ef;font-weight:600;white-space:pre-line;overflow:auto;user-select:text;display:flex;align-items:center}
#gm-hud-status[data-action]:not([data-action=""]){cursor:pointer}
#gm-resize{position:absolute;right:0;bottom:0;width:26px;height:26px;cursor:nwse-resize;touch-action:none;user-select:none}
#gm-resize:after{content:'';position:absolute;right:3px;bottom:3px;width:20px;height:20px;
 background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Cpath d='M2 18L18 2M8 18L18 8M14 18L18 14' fill='none' stroke='%2322c55e' stroke-width='1.6'/%3E%3C/svg%3E") center/20px 20px no-repeat}
#gm-resize:focus-visible{outline:2px solid #22c55e;outline-offset:-3px}
@media(prefers-reduced-motion:reduce){#gm-gear{animation:none!important}}
`;
  (document.head || document.documentElement).appendChild(s);
}

function hudLineCount(value = cfg.multiPv) {
  return Math.max(1, Math.min(3, Number(value) || 2));
}
function hudBaseHeight(count) { return 88 + 32 * hudLineCount(count); }
function hudMinHeight(count) { return 76 + 22 * hudLineCount(count); }
let hudMeasureContext = null;
const hudWidthCache = new Map();
function hudTextWidth(value, size, bold) {
  const key = size + ':' + (bold ? 'b:' : 'n:') + value;
  if (hudWidthCache.has(key)) return hudWidthCache.get(key);
  let width;
  try {
    if (!hudMeasureContext) hudMeasureContext = document.createElement('canvas').getContext('2d');
    hudMeasureContext.font = (bold ? '700 ' : '400 ') + size + 'px Arial';
    width = hudMeasureContext.measureText(value).width;
  } catch (_) { width = String(value).length * size * .5; }
  hudWidthCache.set(key, width); return width;
}
function hudStatusWidth(size) {
  const samples = [TXT_NO_TOKEN, TXT_CONSENT, TXT_NOT_DETECTED, TXT_INCONSISTENT,
    TXT_CONNECTING, TXT_RECONNECTING, TXT_TOKEN_BAD, TXT_UNAVAILABLE, TXT_LOST,
    TXT_API_CHANGED, TXT_VS_HUMAN, TXT_VARIANT, TXT_POSITION, TXT_ENG_FAILED,
    TXT_ENG_BUSY, TXT_STORAGE, TXT_OPP_TURN, TXT_ANALYZING, TXT_ENG_START,
    TXT_ENG_ERR, TXT_GAME_OVER + 'outoftime', TXT_RATE_LIMIT + '3600 s'];
  return Math.max(...samples.flatMap(t => t.split('\n')).map(t => hudTextWidth(t, size, true)));
}
function hudMinimumWidth() { return Math.max(300, Math.ceil(hudStatusWidth(12) + 42)); }

// Only explicit geometry/count changes affect dimensions; stream output never does.
function fitHudRect(rect, viewport, count = cfg.multiPv) {
  const vw = Math.max(1, Number(viewport.width) || 1), vh = Math.max(1, Number(viewport.height) || 1);
  const gap = Math.min(8, Math.floor(Math.min(vw, vh) / 8));
  const width = Math.min(Math.max(1, vw - gap * 2), Math.max(hudMinimumWidth(), Number(rect.width) || 330));
  const height = Math.min(Math.max(1, vh - gap * 2), Math.max(hudMinHeight(count), Number(rect.height) || hudBaseHeight(count)));
  const left = Number.isFinite(rect.left) ? rect.left : vw - width - gap;
  const top = Number.isFinite(rect.top) ? rect.top : gap;
  return { left: Math.max(gap, Math.min(left, vw - gap - width)),
    top: Math.max(gap, Math.min(top, vh - gap - height)), width, height };
}
function hudViewport() {
  return { width: window.innerWidth || document.documentElement.clientWidth || 1024,
    height: window.innerHeight || document.documentElement.clientHeight || 768 };
}
function hudSizing(rect, count = cfg.multiPv) {
  count = hudLineCount(count);
  const scale = Math.max(.5, Math.min(1.8, rect.width / 330, rect.height / hudBaseHeight(count)));
  let statusFont = Math.max(12, Math.round(14 * scale));
  while (statusFont > 6 && hudStatusWidth(statusFont) > rect.width - 42) statusFont--;
  const statusLine = Math.ceil(statusFont * 16 / 14), footer = statusLine * 2 + 4;
  let header = Math.max(32, Math.round(40 * scale));
  header = Math.max(0, Math.min(header, rect.height - footer - 12 - count * 22));
  const available = Math.max(0, rect.height - header - footer - 12);
  let moveFont = Number.isFinite(rect.moveFont) ? rect.moveFont : Math.max(16, Math.min(36, Math.round(23 * scale)));
  const fontPlan = size => {
    const ratio = size / 23;
    return { utility: Math.max(10, Math.round(14 * ratio)), evaluation: size };
  };
  const rowBudget = size => {
    const f = fontPlan(size);
    return hudTextWidth('[3]', f.utility, true) + hudTextWidth('1000) ...', f.utility, false)
      + (cfg.masterMode ? Math.max(hudTextWidth('Bishop c1xh6', size, true), hudTextWidth('Knight b1xd2', size, true)) : hudTextWidth('Knight c3 ►', size, true))
      + hudTextWidth('−999.99', f.evaluation, true) + 38;
  };
  while (moveFont > 6 && (Math.ceil(moveFont * 1.25) + 2 > available / count || rowBudget(moveFont) > rect.width)) moveFont--;
  const fonts = fontPlan(moveFont);
  const rowHeight = Math.max(0, Math.min(Math.round(32 * scale), Math.floor(available / count)));
  return { scale, header, footer, statusFont, statusLine, moveFont,
    utilityFont: fonts.utility, evaluationFont: fonts.evaluation, rowHeight };
}
function adjustHudLineCount(previous, next) {
  previous = hudLineCount(previous); next = hudLineCount(next);
  if (previous !== next) {
    const size = hudSizing(preferredRect, previous);
    preferredRect.height = Math.max(hudMinHeight(next), preferredRect.height + (next - previous) * size.rowHeight);
    preferredRect.moveFont = size.moveFont;
    // Absorb integer rounding into height, not into the selected hint font.
    for (let n = 0; n < 16 && hudSizing(preferredRect, next).moveFont < size.moveFont; n++) preferredRect.height++;
  }
  preferredRect.lines = next;
}
function restorePos() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HUD_RECT_KEY) || 'null');
    if (saved && ['top', 'left', 'width', 'height'].every(k => Number.isFinite(saved[k]) || (k === 'left' && saved[k] === null))) {
      preferredRect = { left: saved.left, top: saved.top, width: saved.width, height: saved.height, lines: hudLineCount(saved.lines) };
      if (Number.isFinite(saved.moveFont) && saved.moveFont >= 6 && saved.moveFont <= 36) preferredRect.moveFont = saved.moveFont;
      adjustHudLineCount(preferredRect.lines, cfg.multiPv);
    } else {
      // Earlier preview geometry used a different count/font model. Keep its position.
      const old = JSON.parse(sessionStorage.getItem('gm_hint_rect_v2') || sessionStorage.getItem(POS_KEY) || 'null');
      if (old) for (const k of ['top', 'left']) {
        if (Number.isFinite(old[k])) preferredRect[k] = old[k];
        else if (typeof old[k] === 'string' && /^-?\d+(\.\d+)?px$/.test(old[k])) preferredRect[k] = parseFloat(old[k]);
      }
      preferredRect.width = 330; preferredRect.height = hudBaseHeight(cfg.multiPv); preferredRect.lines = hudLineCount();
    }
  } catch (_) {}
}
function savePos() {
  try { sessionStorage.setItem(HUD_RECT_KEY, JSON.stringify(preferredRect)); } catch (_) {}
}
function layoutHud() {
  if (!hintEl) return;
  const r = fitHudRect(preferredRect, hudViewport());
  const size = hudSizing(Object.assign({}, r, { moveFont: preferredRect.moveFont }));
  Object.assign(hintEl.style, { left: r.left + 'px', top: r.top + 'px', right: 'auto', width: r.width + 'px', height: r.height + 'px' });
  hud.header.style.height = size.header + 'px';
  hud.header.style.fontSize = Math.max(12, Math.round(15 * size.scale)) + 'px';
  hud.dtext.style.fontSize = Math.max(12, Math.round(16 * size.scale)) + 'px';
  hud.gear.style.fontSize = Math.max(16, Math.round(20 * size.scale)) + 'px';
  hud.body.style.fontSize = size.moveFont + 'px';
  for (const cell of hud.body.querySelectorAll('td')) {
    if (cell.className === 'gm-utility') cell.style.fontSize = size.utilityFont + 'px';
    if (cell.className === 'gm-evaluation') cell.style.fontSize = size.evaluationFont + 'px';
  }
  for (const row of hud.body.querySelectorAll('tr')) row.style.height = size.rowHeight + 'px';
  Object.assign(hud.status.style, { height: size.footer + 'px', fontSize: size.statusFont + 'px', lineHeight: size.statusLine + 'px' });
}

function beginHudGesture(e, kind) {
  if (e.button !== 0 || !e.isTrusted) return;
  e.preventDefault();
  const start = fitHudRect(preferredRect, hudViewport());
  const sx = e.clientX, sy = e.clientY;
  hudGesture = true;
  suppressHudClick = false;
  const move = ev => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    suppressHudClick = true;
    const next = kind === 'resize'
      ? { left: start.left, top: start.top, width: Math.max(hudMinimumWidth(), start.width + dx), height: Math.max(hudMinHeight(cfg.multiPv), start.height + dy) }
      : { left: start.left + dx, top: start.top + dy, width: preferredRect.width, height: preferredRect.height, moveFont: preferredRect.moveFont };
    const fitted = fitHudRect(next, hudViewport());
    preferredRect = { left: fitted.left, top: fitted.top, width: next.width, height: next.height };
    if (kind === 'move' && Number.isFinite(next.moveFont)) preferredRect.moveFont = next.moveFont;
    layoutHud();
  };
  const end = () => {
    hudGesture = null; savePos();
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', end);
    window.removeEventListener('blur', end);
    setTimeout(() => { suppressHudClick = false; }, 0);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', end);
  window.addEventListener('blur', end);
}

function hudHidden() { return paused || cfg.enableHints === false; }

function ensureHint() {
  if (hintEl && document.contains(hintEl)) return;
  if (!document.body) return;
  injectGearStyle();
  hintEl = el('div'); hintEl.id = 'gm-hint';
  hintEl.style.display = 'none';
  const header = el('div'); header.id = 'gm-hud-header'; header.title = 'Drag to move';
  const gear = makeGear(false), ename = el('span'), dtext = el('span');
  ename.id = 'gm-engine-name'; dtext.id = 'gm-depth';
  header.append(gear, ename, dtext);
  const body = el('div'); body.id = 'gm-hud-body';
  const status = el('div'); status.id = 'gm-hud-status'; status.setAttribute('aria-live', 'polite');
  const grip = el('div'); grip.id = 'gm-resize'; grip.title = 'Drag to resize';
  grip.setAttribute('role', 'button'); grip.setAttribute('tabindex', '0'); grip.setAttribute('aria-label', 'Resize hints; use arrow keys');
  header.addEventListener('mousedown', e => beginHudGesture(e, 'move'));
  grip.addEventListener('mousedown', e => beginHudGesture(e, 'resize'));
  grip.addEventListener('keydown', e => {
    const changes = { ArrowRight: [16, 0], ArrowLeft: [-16, 0], ArrowDown: [0, 16], ArrowUp: [0, -16] };
    if (!e.isTrusted || !changes[e.key]) return;
    e.preventDefault();
    const [dx, dy] = changes[e.key];
    delete preferredRect.moveFont;
    preferredRect.width = Math.max(hudMinimumWidth(), preferredRect.width + dx);
    preferredRect.height = Math.max(hudMinHeight(cfg.multiPv), preferredRect.height + dy);
    layoutHud(); savePos();
  });
  hintEl.append(header, body, status, grip);
  hud = { mode: 'shell', header, gear, ename, dtext, body, status, grip };
  hintEl.addEventListener('click', e => {
    if (!e.isTrusted || hudGesture || suppressHudClick) return;
    // Selecting text or interacting with geometry is never a recovery action.
    if (e.target && e.target !== hintEl && e.target !== status) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    onHudClick();
  });
  document.body.appendChild(hintEl);
  restorePos(); layoutHud();
}

function hideHud() {
  lastStatus = null;
  if (hintEl) hintEl.style.display = 'none';
}

function keepResultForStatus(text) {
  return [TXT_CONNECTING, TXT_RECONNECTING, TXT_LOST, TXT_ANALYZING, TXT_OPP_TURN,
    TXT_ENG_START, TXT_ENG_BUSY, TXT_ENG_FAILED, TXT_ENG_ERR, TXT_POSITION, TXT_UNAVAILABLE].includes(text)
    || text.startsWith(TXT_RATE_LIMIT) || text.startsWith(TXT_GAME_OVER);
}

function setStatus(text, type, action) {
  lastStatus = { text, type, action: action || null };
  if (!keepResultForStatus(text)) lastResult = null;
  renderStatus();
}
function renderStatus() {
  ensureHint();
  if (!hintEl) return;
  hintEl.style.display = hudHidden() ? 'none' : 'flex';
  if (hudHidden()) return;
  if (lastResult) drawResult();
  else {
    hud.body.replaceChildren();
    hud.ename.textContent = engineName || BRAND_NAME;
    hud.dtext.textContent = '';
  }
  const state = lastStatus;
  hud.status.textContent = state ? state.text : '';
  hud.status.setAttribute('data-action', state && state.action ? state.action : '');
  hud.status.style.cursor = state && state.action ? 'pointer' : 'text';
  const running = !!(session && session.an.running);
  hud.gear.style.animationPlayState = running ? 'running' : 'paused';
  hud.gear.style.color = '#22c55e';
  layoutHud();
}

function makeGear(running) {
  const g = el('span', 'display:inline-block;animation:gm-spin 2s linear infinite;'
    + `animation-play-state:${running ? 'running' : 'paused'};color:#22c55e`, '⚙︎');
  g.id = 'gm-gear'; return g;
}

// ==================== MOVE FORMAT ====================
const PIECE_EN = { p:'Pawn', n:'Knight', b:'Bishop', r:'Rook', q:'Queen', k:'King' };
const PROMO_EN = { q:'Q', r:'R', b:'B', n:'N' };

function charAtSq(fen, sq) {
  if (!sq || sq.length < 2) return null;
  const f = sq.charCodeAt(0) - 97, rk = 8 - parseInt(sq[1]);
  if (f < 0 || f > 7 || rk < 0 || rk > 7) return null;
  const rows = fen.split(' ')[0].split('/');
  let c = 0;
  for (const ch of (rows[rk] || '')) {
    if (/\d/.test(ch)) { c += +ch; continue; }
    if (c === f) return ch; c++;
  }
  return null;
}
function pieceAt(fen, mv) {
  const ch = charAtSq(fen, mv ? mv.slice(0,2) : '');
  return ch ? (PIECE_EN[ch.toLowerCase()] || '?') : '?';
}
function fmtMove(fen, mv) {
  if (!fen || !mv || mv.length < 4) return mv;
  const from = mv.slice(0,2), to = mv.slice(2,4), promo = mv[4];
  const srcCh = charAtSq(fen, from);
  if (!srcCh) return mv;
  const piece = srcCh.toLowerCase();
  if (piece === 'k') {
    const df = to.charCodeAt(0) - from.charCodeAt(0);
    if (df ===  2) return '0-0';
    if (df === -2) return '0-0-0';
  }
  const dstCh = charAtSq(fen, to);
  const isCapture = !!dstCh || (piece === 'p' && from[0] !== to[0]);
  const promoStr  = promo ? '=' + (PROMO_EN[promo] || promo.toUpperCase()) : '';
  return from + (isCapture ? 'x' : '-') + to + promoStr;
}
function fmtMoveWithPiece(fen, mv) {
  const move = fmtMove(fen, mv);
  if (move === '0-0' || move === '0-0-0') return move;
  const srcCh = charAtSq(fen, mv ? mv.slice(0,2) : '');
  if (!srcCh) return move;
  const p = srcCh.toLowerCase();
  const name = PIECE_EN[p] || '';
  return (name && p !== 'p') ? name + ' ' + move : move;
}

// Training format: piece + start square + ► marker, TARGET HIDDEN.
// Unified for ALL pieces incl. pawn: "Rook d2 ►", "Pawn e2 ►". Master mode
// (easter egg) overrides this with the full move.
function fmtPieceOrigin(fen, mv) {
  if (!fen || !mv || mv.length < 4) return mv || '';
  const from  = mv.slice(0, 2);
  const srcCh = charAtSq(fen, from);
  const arrow = '►';
  if (!srcCh) return from + ' ' + arrow;
  const name = PIECE_EN[srcCh.toLowerCase()] || '';
  return name ? name + ' ' + from + ' ' + arrow : from + ' ' + arrow;
}

// ==================== RENDER PV LINES ====================
// Persistent gear node: the animation never restarts between updates.
function renderPvLines(s) {
  if (!live(s) || hudHidden()) return;
  const keys = Object.keys(s.an.lines).map(Number).sort((x, y) => x - y);
  if (!keys.length) return;
  lastResult = { gameId: s.gameId, fen: s.an.fen, lines: Object.assign({}, s.an.lines),
    playerColor: s.playerColor, moveNum: s.moveNum, engineName: engineName || 'Stockfish' };
  lastStatus = null;
  renderStatus();
}

function drawResult() {
  const a = lastResult;
  const keys = Object.keys(a.lines).map(Number).sort((x, y) => x - y).slice(0, cfg.multiPv);
  if (!keys.length) return;
  const first = a.lines[keys[0]], dots = first.isBlack ? ' ...' : '';
  hud.mode = 'pv';
  hud.ename.textContent = lastResult.engineName;
  hud.ename.title = lastResult.engineName;
  hud.dtext.textContent = 'Depth: ' + first.depth;
  const table = el('table', 'border-collapse:collapse;width:100%;font-size:inherit');
  for (const k of keys) {
    const L = a.lines[k];
    let evalStr = '', evalClr = CLR_NEU;
    if (L.mate !== undefined) {
      const signChar = L.mate >= 0 ? 'M+' : 'M−';
      evalStr = signChar + Math.abs(L.mate);
      const pov = (lastResult.playerColor || 'w') === 'b' ? -L.mate : L.mate;
      evalClr = pov > 0 ? CLR_GOOD : CLR_BAD;
    } else if (L.cp !== undefined) {
      if (cfg.showEval) {
        const abs = (Math.abs(L.cp) / 100).toFixed(2);
        evalStr = (L.cp >= 0 ? '+' : '−') + abs;
      }
      const pov = (lastResult.playerColor || 'w') === 'b' ? -L.cp : L.cp;
      evalClr = pov > EVAL_GOOD_THRESHOLD  ? CLR_GOOD :
                pov < -EVAL_BAD_THRESHOLD   ? CLR_BAD  : CLR_NEU;
    }
    // Hint detail: master mode → full move "Rook d2-d4"; "piece" → piece name
    // only; otherwise piece + start square "Rook d2 ►" (target hidden).
    let moveTxt;
    if (cfg.masterMode)               moveTxt = fmtMoveWithPiece(L.snapFen, L.bestMove);
    else if (cfg.hintMode === 'piece') moveTxt = pieceAt(L.snapFen, L.bestMove);
    else                              moveTxt = fmtPieceOrigin(L.snapFen, L.bestMove);
    const tr = el('tr');
    const rank = el('td', 'width:1%;white-space:nowrap;padding:1px 4px 1px 0;color:#075fc8;font-weight:700', '[' + k + ']');
    const turn = el('td', `width:1%;white-space:nowrap;padding:1px 4px 1px 0;color:${CLR_NEU}`, lastResult.moveNum + ')' + dots);
    rank.className = turn.className = 'gm-utility';
    const moveCell = el('td', `width:100%;text-align:left;padding:1px 6px 1px 0;color:${evalClr};font-weight:700`);
    // Preserve move notation and evaluation warning colors; distinguish origin squares.
    for (const part of moveTxt.split(/([a-h][1-8])/g)) {
      const span = el('span', /^[a-h][1-8]$/.test(part) && evalClr !== CLR_BAD ? 'color:#123f75' : '', part);
      moveCell.appendChild(span);
    }
    tr.append(rank, turn, moveCell);
    if (cfg.showEval || L.mate !== undefined) {
      const evaluation = el('td', `width:1%;white-space:nowrap;padding:1px 0;color:${evalClr};font-weight:700;text-align:right`, evalStr);
      evaluation.className = 'gm-evaluation'; tr.appendChild(evaluation);
    }
    table.appendChild(tr);
  }
  hud.body.replaceChildren(table);
}

// ==================== HUD CLICK ====================
function onHudClick() {
  const s = session;
  const action = lastStatus ? lastStatus.action : null;
  if (action === 'consent') { send({ type: 'OPEN_CONSENT' }).catch(() => {}); return; }
  if (action === 'retry') { restartSession(); return; }
  if (!live(s) || hudHidden()) return;
  if (action === 'engine-retry') { analyze(s, { force: true, engineRetry: true }); return; }
  if (action === 'engine-here' && s.allowed && s.currentFen) analyze(s, { force: true });
}

// ==================== ENGINE (background worker) ====================
function stopAnalysis(s) {
  const a = s.an;
  clearTimer(s, 'watchdog');
  if (a.running) {
    a.running = false;
    send({ type: 'ENGINE_STOP', session: s.gen, jobId: a.jobId }).catch(() => {});
  }
}

const WATCHDOG_MS = 8000;
const ENGINE_START_GRACE_MS = 30000;

function analyze(s, opts) {
  opts = opts || {};
  if (!live(s) || !s.allowed || !s.currentFen || hudHidden()) return;
  const a = s.an, fen = s.currentFen;
  if (fen.split(' ')[1] === s.botColor) {
    stopAnalysis(s);
    setStatus(TXT_OPP_TURN, 'wait');
    return;
  }
  if (!opts.force && a.running && a.fen === fen) return;
  clearTimer(s, 'watchdog');
  a.jobId++; a.fen = fen; a.running = true; a.started = false; a.lines = {};
  if (!opts.watchdogRetry) a.retried = false;
  const jobId = a.jobId;
  setStatus(TXT_ANALYZING, 'wait');
  setTimer(s, 'watchdog', () => onWatchdog(s, jobId), WATCHDOG_MS);
  send({
    type: 'ENGINE_ANALYZE', fen, session: s.gen, jobId,
    movetime: cfg.movetime, infinite: cfg.mode === 'infinite',
    multiPv: cfg.multiPv, retry: !!opts.engineRetry,
  }).then(resp => {
    if (!live(s) || a.jobId !== jobId || !a.running) return;
    if (!resp || !resp.ok) {
      a.running = false; clearTimer(s, 'watchdog');
      if (resp && resp.error === 'engine') setStatus(TXT_ENG_FAILED, 'err', 'engine-retry');
      else setStatus(TXT_ENG_ERR, 'err');
      return;
    }
    if (!resp.ready) {
      if (!a.started) setStatus(TXT_ENG_START, 'wait');
      setTimer(s, 'watchdog', () => onWatchdog(s, jobId), ENGINE_START_GRACE_MS);
    }
  }).catch(() => {
    if (!live(s) || a.jobId !== jobId) return;
    a.running = false; clearTimer(s, 'watchdog');
    setStatus(TXT_ENG_ERR, 'err');
  });
}

// No engine output in time: one retry (lost reply), then report.
function onWatchdog(s, jobId) {
  const a = s.an;
  if (!live(s) || a.jobId !== jobId || !a.running || a.started) return;
  if (!a.retried) {
    a.retried = true;
    analyze(s, { force: true, watchdogRetry: true });
    return;
  }
  stopAnalysis(s);
  setStatus(TXT_ENG_BUSY, 'err', 'engine-here');
}

function onEngineLine(s, line) {
  const a = s.an;
  if (line.startsWith('bestmove')) {
    a.running = false;
    clearTimer(s, 'watchdog');
    // A completed search is not a connection event. Keep its result and
    // clear only analysis progress; preserve genuine connection/error states.
    if (lastStatus && [TXT_ANALYZING, TXT_ENG_START].includes(lastStatus.text)) lastStatus = null;
    renderStatus();
    return;
  }
  const info = parseEngineInfo(line);
  if (!info) return;
  if (!a.started) { a.started = true; a.retried = false; clearTimer(s, 'watchdog'); }
  const snap = a.fen;
  if (pieceAt(snap, info.move) === '?') return;
  const prev = a.lines[info.multipv];
  if (prev && info.depth < prev.depth) return;
  // UCI scores are from the side to move; convert to White's point of view.
  const isBlack = snap.split(' ')[1] === 'b';
  a.lines[info.multipv] = {
    depth: info.depth, bestMove: info.move, snapFen: snap, isBlack,
    cp: info.cp === undefined ? undefined : (isBlack ? -info.cp : info.cp),
    mate: info.mate === undefined ? undefined : (isBlack ? -info.mate : info.mate),
  };
  renderPvLines(s);
}

// ==================== POSITION ====================
function processPosition(s) {
  const fen = replayPosition(s.initialFen, s.moves);
  if (!fen) {
    stopAnalysis(s);
    s.currentFen = null;
    setStatus(TXT_POSITION, 'err');
    return false;
  }
  s.moveNum = parseInt(fen.split(' ')[5], 10) || 1;
  if (fen === s.currentFen && (s.an.running || hud.mode === 'pv' || s.an.preempted)) return true;
  stopAnalysis(s);
  s.currentFen = fen;
  s.an.preempted = false;
  s.an.lines = {};
  if (hudHidden()) return true;
  analyze(s, { force: true });
  return true;
}

// ==================== STREAM ====================
function apiChanged(s) { endSession(s, TXT_API_CHANGED, 'err'); }

function endGame(s, status) { endSession(s, TXT_GAME_OVER + status, 'ok'); }

// Handles one NDJSON event. Returns false when the session must stop reading.
function handleEvent(s, ev, first) {
  if (!isObj(ev) || typeof ev.type !== 'string') { apiChanged(s); return false; }
  s.lastEventAt = Date.now();
  if (first && ev.type !== 'gameFull') { apiChanged(s); return false; }

  if (ev.type === 'gameFull') {
    if (checkGameFull(ev, s.gameId)) { apiChanged(s); return false; }
    clearTimer(s, 'firstEvent');
    s.gotFull = true;
    const opp = classifyOpponents(ev.white, ev.black);
    if (opp.kind !== 'ai') { endSession(s, TXT_VS_HUMAN, 'err'); return false; }
    if (!isSupportedVariant(ev.variant.key)) { endSession(s, TXT_VARIANT, 'info'); return false; }
    const st = classifyStatus(ev.state.status);
    if (st === 'unknown') { apiChanged(s); return false; }
    if (st === 'terminal') { endGame(s, ev.state.status); return false; }
    s.allowed = true;
    s.botColor = opp.botColor;
    s.playerColor = opp.botColor === 'w' ? 'b' : 'w';
    s.initialFen = ev.initialFen;
    s.moves = ev.state.moves;
    const valid = processPosition(s);
    if (!valid) return live(s);
    s.maxPly = Math.max(s.maxPly, s.moves.trim().split(/\s+/).filter(Boolean).length);
    const conn = s.connId;
    // A stream that keeps running restores the full retry budget.
    setTimer(s, 'stable', () => { if (s.connId === conn && s.ctrl) { s.attempts = 0; s.failures = 0; } }, STABLE_STREAM_MS);
    return live(s);
  }

  if (ev.type === 'gameState') {
    if (!s.gotFull || checkGameState(ev)) { apiChanged(s); return false; }
    const st = classifyStatus(ev.status);
    if (st === 'unknown') { apiChanged(s); return false; }
    if (st === 'terminal') { endGame(s, ev.status); return false; }
    s.moves = ev.moves;
    const valid = processPosition(s);
    const ply = s.moves.trim().split(/\s+/).filter(Boolean).length;
    if (valid && ply > s.maxPly) {
      // Progress beyond the session watermark, not replayed reconnect data.
      s.maxPly = ply;
      s.attempts = 0; s.failures = 0;
    }
    return live(s);
  }
  // Other event types (chatLine, opponentGone, …) are not used.
  return true;
}

// Starts (or schedules) one stream request, respecting the 429 cooldown and
// the shared attempt budget.
async function connect(s) {
  if (!live(s) || s.ctrl) return;
  clearTimer(s, 'retry');
  const wait = notBefore - Date.now();
  if (wait > 0) { showRateLimit(s); setTimer(s, 'retry', () => connect(s), wait); return; }
  if (s.attempts >= MAX_ATTEMPTS) { connectionLost(s); return; }
  if (s.attempts > 0 && document.visibilityState === 'hidden') {
    // Background tab: wait until the user comes back (no requests meanwhile).
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      if (live(s)) connect(s);
    };
    addListener(s, document, 'visibilitychange', onVisible);
    return;
  }
  // Consent and token are checked right before every request.
  const ok = await gateOpen(s);
  if (!ok || !live(s) || s.ctrl) return;
  const token = cfg.token;

  s.attempts++;
  const conn = ++s.connId;
  const ctrl = s.ctrl = new AbortController();
  s.gotFull = false;
  setStatus(s.attempts > 1 || s.failures > 0 ? TXT_RECONNECTING : TXT_CONNECTING, 'wait');
  setTimer(s, 'firstEvent', () => { if (s.ctrl === ctrl) transient(s, ctrl); }, FIRST_EVENT_MS);
  dbg('stream request', s.gameId, 'attempt', s.attempts);

  let resp;
  try {
    resp = await fetch(streamUrl(s.gameId), {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: ctrl.signal,
    });
  } catch (_) {
    if (live(s) && s.ctrl === ctrl) transient(s, ctrl);
    return;
  }
  if (!live(s) || s.ctrl !== ctrl) return;

  const kind = classifyHttpStatus(resp.status);
  if (kind !== 'ok') {
    s.ctrl = null; clearTimer(s, 'firstEvent');
    try { ctrl.abort(); } catch (_) {}
    if (kind === 'auth')      { endSession(s, TXT_TOKEN_BAD, 'err'); return; }
    if (kind === 'notfound')  { endSession(s, TXT_UNAVAILABLE, 'info'); return; }
    if (kind === 'fatal')     { apiChanged(s); return; }
    if (kind === 'ratelimit') {
      const ra = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('Retry-After') : null;
      notBefore = Math.max(notBefore, Date.now() + rateLimitDelay(parseRetryAfter(ra, Date.now())));
      connect(s);   // waits for notBefore, or reports the exhausted budget
      return;
    }
    transient(s, null);
    return;
  }
  await readStream(s, ctrl, conn, resp);
}

async function readStream(s, ctrl, conn, resp) {
  if (!resp.body || typeof resp.body.getReader !== 'function') { s.ctrl = null; apiChanged(s); return; }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = 0;
  const touch = () => setTimer(s, 'idle', () => { if (s.ctrl === ctrl) transient(s, ctrl); }, IDLE_MS);
  touch();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (!live(s) || s.ctrl !== ctrl) return;
      if (done) break;
      touch();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        if (i > MAX_BUFFER_BYTES || new TextEncoder().encode(buf.slice(0, i)).length > MAX_BUFFER_BYTES) { apiChanged(s); return; }
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;   // keepalive
        let ev;
        try { ev = JSON.parse(line); } catch (_) { apiChanged(s); return; }
        const go = handleEvent(s, ev, events === 0);
        events++;
        if (!go || !live(s) || s.ctrl !== ctrl) return;
      }
      if (buf.length > MAX_BUFFER_BYTES || new TextEncoder().encode(buf).length > MAX_BUFFER_BYTES) { apiChanged(s); return; }
    }
  } catch (_) {
    if (live(s) && s.ctrl === ctrl) transient(s, ctrl);
    return;
  }
  // End of stream: the last line may lack "\n". A fragment that does not parse
  // was cut off by the disconnect, so it is dropped rather than reported.
  buf += dec.decode();
  const tail = buf.trim();
  if (tail) {
    let ev = null;
    try { ev = JSON.parse(tail); } catch (_) {
      if (events === 0) { apiChanged(s); return; }
      ev = null;
    }
    if (ev !== null) {
      if (!handleEvent(s, ev, events === 0) || !live(s) || s.ctrl !== ctrl) return;
      events++;
    }
  }
  if (live(s) && s.ctrl === ctrl) transient(s, ctrl);
}

// Network error, 5xx, EOF, idle or missing first event: back off and retry
// within the shared budget.
function transient(s, ctrl) {
  if (!live(s)) return;
  if (ctrl && s.ctrl !== ctrl) return;
  if (s.ctrl) { const c = s.ctrl; s.ctrl = null; try { c.abort(); } catch (_) {} }
  clearTimer(s, 'firstEvent'); clearTimer(s, 'idle'); clearTimer(s, 'stable');
  if (s.attempts >= MAX_ATTEMPTS) { connectionLost(s); return; }
  const delay = backoffDelay(s.failures, Math.random());
  s.failures++;
  setStatus(TXT_RECONNECTING, 'wait');
  setTimer(s, 'retry', () => connect(s), Math.max(delay, notBefore - Date.now()));
}

function connectionLost(s) {
  if (!live(s)) return;
  s.lost = true;
  endSession(s, TXT_LOST, 'err', 'retry');
}

function showRateLimit(s) {
  const secs = Math.max(1, Math.ceil((notBefore - Date.now()) / 1000));
  setStatus(TXT_RATE_LIMIT + secs + ' s', 'err');
  setTimer(s, 'rateTick', () => { if (!s.ctrl && notBefore > Date.now()) showRateLimit(s); }, 1000);
}

// Consent → token. Shows the matching HUD and returns false when blocked.
async function gateOpen(s) {
  if (!settingsOk) { stopAnalysis(s); s.waiting = 'storage'; setStatus(TXT_STORAGE, 'err'); return false; }
  let state = 'error';
  try {
    const r = await send({ type: 'CONSENT_GET' });
    if (r && typeof r.state === 'string') state = r.state;
  } catch (_) { state = 'error'; }
  if (!live(s)) return false;
  if (state !== 'granted') { stopAnalysis(s); s.waiting = 'consent'; setStatus(TXT_CONSENT, 'info', 'consent'); return false; }
  if (!cfg.token || tokenSuppressed) { stopAnalysis(s); s.waiting = 'token'; setStatus(TXT_NO_TOKEN, 'err'); return false; }
  if (!validTokenText(cfg.token)) { stopAnalysis(s); s.waiting = 'token'; setStatus(TXT_TOKEN_BAD, 'err'); return false; }
  s.waiting = null;
  return true;
}

// ==================== BOARD OBSERVER ====================
// cg-board changes are only a hint that the stream may be stale: if the board
// changed and no event arrived for BOARD_SILENCE_MS, one fast reconnect is
// tried from the shared budget, never before the 429 cooldown.
function readBoard(boardEl) {
  const pieces = [];
  for (const p of boardEl.querySelectorAll(SEL_PIECE)) {
    pieces.push({ cls: p.className || '', pos: (p.style && p.style.transform) || '' });
  }
  const wrap = boardEl.closest ? boardEl.closest(SEL_BOARD_WRAP) : null;
  const orient = wrap && wrap.classList && wrap.classList.contains('orientation-black') ? 'b' : 'w';
  return { sig: boardSignature(pieces), orient };
}

function ensureBoardObserver(s) {
  if (!live(s)) return;
  const boardEl = document.querySelector(SEL_BOARD);
  if (boardEl === s.board.el) return;
  if (s.board.obs) { s.board.obs.disconnect(); s.board.obs = null; }
  s.board.el = boardEl;
  if (!boardEl) return;
  const b = readBoard(boardEl);
  s.board.sig = b.sig; s.board.orient = b.orient;
  s.board.obs = new MutationObserver(() => {
    if (!live(s)) return;
    if (!s.timers.has('boardDebounce')) setTimer(s, 'boardDebounce', () => onBoardSettled(s), BOARD_DEBOUNCE_MS);
  });
  s.board.obs.observe(boardEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
}

function onBoardSettled(s) {
  if (!live(s) || !s.board.el) return;
  const b = readBoard(s.board.el);
  if (b.sig === s.board.sig) return;
  const flipped = b.orient !== s.board.orient;
  s.board.sig = b.sig; s.board.orient = b.orient;
  if (flipped) return;   // board turned around, not a move
  const at = Date.now();
  setTimer(s, 'boardSilence', () => onBoardSilence(s, at), BOARD_SILENCE_MS);
}

function onBoardSilence(s, changedAt) {
  if (!live(s) || hudHidden() || s.lost || s.waiting) return;
  if (s.lastEventAt >= changedAt) return;          // the stream did deliver
  const now = Date.now();
  if (now - s.lastFastAt < FAST_RECONNECT_GAP_MS) return;
  if (s.attempts >= MAX_ATTEMPTS) return;
  s.lastFastAt = now;
  dbg('board changed but stream silent: fast reconnect');
  if (s.ctrl) { const c = s.ctrl; s.ctrl = null; try { c.abort(); } catch (_) {} }
  clearTimer(s, 'firstEvent'); clearTimer(s, 'idle'); clearTimer(s, 'stable');
  connect(s);
}

// ==================== PAGE CONTEXT ====================
function readContext() {
  const q = sel => { try { return document.querySelector(sel); } catch (_) { return null; } };
  const canon = q(SEL_CANONICAL), og = q(SEL_OG_URL);
  return classifyPage({
    url: location.href,
    tvSingle: !!q(SEL_TV_SINGLE),
    gameSigns: !!(q(SEL_ROUND) || q(SEL_ROUND_APP) || (q(SEL_MAIN_BOARD) && q(SEL_CLOCK))),
    canonical: canon ? canon.getAttribute('href') && canon.href : null,
    ogUrl: og ? og.getAttribute('content') : null,
  });
}

function evaluateContext() {
  const ctx = readContext();
  // A known game session outlives temporary removal of Lichess round/board DOM.
  // The exact URL identity and TV exclusion still gate this exception.
  if (ctx.kind === 'hidden' && session && parseGameUrl(location.href) === session.gameId
      && !document.querySelector(SEL_TV_SINGLE)) {
    ensureBoardObserver(session);
    if (!hintEl || !document.contains(hintEl) || hintEl.style.display === 'none') renderStatus();
    return;
  }
  if (ctx.kind === 'hidden') {
    lastResult = null;
    conflictSince = 0;
    dropSession();
    hideHud();
    return;
  }
  if (ctx.kind === 'no-id') {
    conflictSince = 0;
    dropSession();
    if (!lastStatus || lastStatus.text !== TXT_NOT_DETECTED) setStatus(TXT_NOT_DETECTED, 'err');
    return;
  }
  if (ctx.kind === 'conflict') {
    // Never keep or start a stream while the page disagrees with itself.
    dropSession();
    const now = Date.now();
    if (!conflictSince) conflictSince = now;
    if (now - conflictSince > CONFLICT_HOLD_MS) {
      if (!lastStatus || lastStatus.text !== TXT_INCONSISTENT) setStatus(TXT_INCONSISTENT, 'err');
    } else {
      setStatus(TXT_INCONSISTENT, 'err');
      scheduleEvaluate(CONFLICT_RECHECK_MS);
    }
    return;
  }
  conflictSince = 0;
  if (session && session.gameId === ctx.id) { ensureBoardObserver(session); return; }
  dropSession();
  startSession(ctx.id);
}

function scheduleEvaluate(ms) {
  if (navTimer) return;
  navTimer = setTimeout(() => { navTimer = null; evaluateContext(); }, ms);
}

function startSession(id) {
  if (lastResult && lastResult.gameId !== id) lastResult = null;
  const s = session = newSession(id);
  ensureBoardObserver(s);
  beginSession(s);
}

async function beginSession(s) {
  const ok = await gateOpen(s);
  if (!ok || !live(s)) return;
  registerEngine();
  connect(s);
}

function restartSession() {
  dropSession();
  evaluateContext();
}

// ==================== SETTINGS, CONSENT, TOKEN CHANGES ====================
async function reloadSettings() {
  const epoch = ++settingsEpoch;
  try {
    const next = await loadSettings();
    if (epoch !== settingsEpoch) return false;
    cfg = Object.assign({}, SETTINGS_DEFAULTS, next); settingsOk = true;
  } catch (_) {
    if (epoch !== settingsEpoch) return false;
    settingsOk = false;
  }
  return true;
}

async function onSettingsChanged() {
  const oldToken = cfg.token, oldOk = settingsOk, oldLines = cfg.multiPv;
  if (!(await reloadSettings())) return;
  if (oldLines !== cfg.multiPv) { adjustHudLineCount(oldLines, cfg.multiPv); savePos(); layoutHud(); }
  if (cfg.token && cfg.token !== oldToken) tokenSuppressed = false;
  const s = session;
  if (cfg.token !== oldToken || settingsOk !== oldOk) {
    if (cfg.token !== oldToken) lastResult = null;
    // Token added, changed or removed (or storage recovered/failed): never keep
    // a stream that was opened with a different token.
    restartSession();
    return;
  }
  if (!live(s)) return;
  if (hudHidden()) { stopAnalysis(s); if (hintEl) hintEl.style.display = 'none'; return; }
  if (s.allowed && s.currentFen) analyze(s, { force: true });
  else renderStatus();
}

function onConsentChanged() {
  lastResult = null;
  // Invalidate synchronously; a slow permission/storage read must not keep
  // the old stream alive. The replacement session checks the gate afresh.
  restartSession();
}

// ==================== MESSAGES ====================
let keepAlivePort = null;
function keepBgAlive() {
  if (keepAlivePort) return;
  try {
    keepAlivePort = browser.runtime.connect({ name: 'genmate' });
    keepAlivePort.onDisconnect.addListener(() => { keepAlivePort = null; setTimeout(keepBgAlive, 1000); });
  } catch(_) { keepAlivePort = null; setTimeout(keepBgAlive, 2000); }
}

function registerEngine() {
  keepBgAlive();
  send({ type: 'ENGINE_REGISTER' })
    .then(r => { if (r && typeof r.engineName === 'string') engineName = r.engineName.slice(0, 40); })
    .catch(() => {});
}

function engineMsgForUs(msg) {
  const s = session;
  return live(s) && msg.session === s.gen && msg.jobId === s.an.jobId ? s : null;
}

function onMessage(msg, sender) {
  if (!sender || sender.id !== browser.runtime.id) return;
  if (!isObj(msg) || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'ENGINE_NAME':
      if (typeof msg.name === 'string') engineName = msg.name.slice(0, 40);
      return;
    case 'ENGINE_LINE': {
      const s = engineMsgForUs(msg);
      if (!s || !s.an.running || typeof msg.line !== 'string' || hudHidden()) return;
      onEngineLine(s, msg.line);
      return;
    }
    case 'ENGINE_PREEMPTED': {
      const s = engineMsgForUs(msg);
      if (!s) return;
      s.an.running = false; s.an.preempted = true; clearTimer(s, 'watchdog');
      setStatus(TXT_ENG_BUSY, 'err', 'engine-here');
      return;
    }
    case 'ENGINE_ERROR': {
      const s = engineMsgForUs(msg);
      if (!s) return;
      s.an.running = false; clearTimer(s, 'watchdog');
      setStatus(TXT_ENG_FAILED, 'err', 'engine-retry');
      return;
    }
    case 'ENGINE_READY': {
      const s = engineMsgForUs(msg);
      if (s && s.an.running && !s.an.started) setStatus(TXT_ANALYZING, 'wait');
      return;
    }
    case 'HINT_HIDE': {
      paused = true;
      if (hintEl) hintEl.style.display = 'none';
      if (session) stopAnalysis(session);
      return Promise.resolve({ ok: true, paused });
    }
    case 'HINT_SHOW': {
      paused = false;
      const s = session;
      if (live(s) && s.allowed && s.currentFen) analyze(s, { force: true });
      else renderStatus();
      return Promise.resolve({ ok: true, paused });
    }
    case 'HUD_GET':
      return Promise.resolve({ ok: true, paused, game: !!(session && session.gameId) });
    case 'SET_MASTER': {
      cfg.masterMode = !!msg.on;
      const s = session;
      if (live(s) && s.allowed && s.currentFen) analyze(s, { force: true });
      return;
    }
    case 'SETTINGS_CHANGED':
      onSettingsChanged();
      return;
    case 'TOKEN_CLEARED':
      lastResult = null;
      tokenSuppressed = true;
      restartSession();
      return;
    case 'CONSENT_CHANGED':
      onConsentChanged();
      return;
  }
}

function onStorageChanged(changes, area) {
  if (area !== 'local' && area !== 'sync') return;
  if (!Object.keys(changes || {}).some(k => SETTINGS_KEYS.includes(k))) return;
  onSettingsChanged();
}

// ==================== INIT ====================
async function boot() {
  browser.runtime.onMessage.addListener(onMessage);
  if (browser.storage && browser.storage.onChanged) browser.storage.onChanged.addListener(onStorageChanged);
  await reloadSettings();
  window.addEventListener('resize', layoutHud);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layoutHud);
  window.addEventListener('popstate', () => scheduleEvaluate(0));
  window.addEventListener('hashchange', () => scheduleEvaluate(0));
  // Watch for URL and markup changes without a retry limit: rematches,
  // pushState navigation, late boards and late page metadata.
  if (document.body) {
    new MutationObserver(() => scheduleEvaluate(NAV_DEBOUNCE_MS))
      .observe(document.body, { childList: true, subtree: true });
  }
  setInterval(evaluateContext, NAV_INTERVAL_MS);
  evaluateContext();
}

boot();
