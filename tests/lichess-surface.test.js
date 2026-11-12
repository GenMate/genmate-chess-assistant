// G2/G4/G5/G7/G8/G17 — pure functions of the Lichess integration surface,
// loaded alone from content.js between the BEGIN/END markers.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadSurface, src, J } = require('./helpers/env');

const S = loadSurface();
const B = 'https://lichess.org';
const page = o => J(S.classifyPage(Object.assign({ url: B + '/', tvSingle: false, gameSigns: false, canonical: null, ogUrl: null }, o)));

test('surface block has both markers in content.js', () => {
  const c = src('content.js');
  assert.ok(c.indexOf('// BEGIN LICHESS INTEGRATION SURFACE') < c.indexOf('// END LICHESS INTEGRATION SURFACE'));
});

test('classifyPage: non-game pages are hidden (segment boundary)', () => {
  for (const p of ['/tv', '/tv/blitz', '/analysis', '/analysis/standard', '/training/abc', '/study/abcdefgh',
    '/broadcast/x', '/editor', '/practice', '/streamer/x', '/learn', '/puzzle', '/storm', '/racer/x', '/streak',
    '/opening', '/@/GenMate', '/team/x', '/tournament/x', '/swiss/x', '/simul/x', '/coach'])
    assert.deepStrictEqual(page({ url: B + p, gameSigns: true }), { kind: 'hidden' }, p);
  // a legacy id that merely starts with "tv" is not the /tv page
  assert.deepStrictEqual(page({ url: B + '/tvabcdef' }), { kind: 'game', id: 'tvabcdef' });
});

test('classifyPage: TV single view is hidden even on a game-like path', () => {
  assert.deepStrictEqual(page({ url: B + '/i40iA4IQ', tvSingle: true, gameSigns: true }), { kind: 'hidden' });
});

test('classifyPage: id from URL, then canonical, then og:url', () => {
  assert.deepStrictEqual(page({ url: B + '/game/i40iA4IQ' }), { kind: 'game', id: 'i40iA4IQ' });
  assert.deepStrictEqual(page({ url: B + '/some-page', gameSigns: true, canonical: B + '/game/AAAAAAAA', ogUrl: B + '/game/BBBBBBBB' }), { kind: 'game', id: 'AAAAAAAA' });
  assert.deepStrictEqual(page({ url: B + '/some-page', gameSigns: true, canonical: 'https://evil.example/game/AAAAAAAA', ogUrl: B + '/game/BBBBBBBB' }), { kind: 'game', id: 'BBBBBBBB' });
});

test('classifyPage: board but no id → no-id; nothing → hidden', () => {
  assert.deepStrictEqual(page({ url: B + '/newgamepath/xyz', gameSigns: true }), { kind: 'no-id' });
  assert.deepStrictEqual(page({ url: B + '/newgamepath/xyz', gameSigns: false }), { kind: 'hidden' });
  assert.deepStrictEqual(page({ url: 'https://example.org/game/i40iA4IQ', gameSigns: true }), { kind: 'hidden' });
});

test('classifyPage: URL id differs from page metadata → conflict', () => {
  assert.deepStrictEqual(page({ url: B + '/game/i40iA4IQ', ogUrl: B + '/game/ZZZZZZZZ' }), { kind: 'conflict', id: 'i40iA4IQ', metaId: 'ZZZZZZZZ' });
  // 12-char and /black variants of the same game are not a conflict
  assert.deepStrictEqual(page({ url: B + '/game/i40iA4IQ/black', ogUrl: B + '/game/i40iA4IQabcd' }), { kind: 'game', id: 'i40iA4IQ' });
});

test('HTTP status mapping', () => {
  const m = { 200: 'ok', 401: 'auth', 403: 'auth', 404: 'notfound', 429: 'ratelimit', 500: 'retry', 502: 'retry', 503: 'retry', 400: 'fatal', 410: 'fatal', 302: 'fatal' };
  for (const [k, v] of Object.entries(m)) assert.strictEqual(S.classifyHttpStatus(Number(k)), v, k);
});

test('Retry-After: seconds, HTTP date, garbage', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.strictEqual(S.parseRetryAfter('120', now), 120000);
  assert.strictEqual(S.parseRetryAfter('Wed, 28 Oct 2026 12:02:00 GMT', now), 120000);
  assert.strictEqual(S.parseRetryAfter('Wed, 28 Oct 2026 11:00:00 GMT', now), 0);
  assert.strictEqual(S.parseRetryAfter('soon', now), 0);
  assert.strictEqual(S.parseRetryAfter(null, now), 0);
  assert.strictEqual(S.rateLimitDelay(0), 60000);
  assert.strictEqual(S.rateLimitDelay(120000), 120000);
});

test('backoff 3/5/8/13/21/30 s with ±20 % jitter', () => {
  const base = [3000, 5000, 8000, 13000, 21000, 30000, 30000, 30000];
  base.forEach((b, i) => {
    assert.strictEqual(S.backoffDelay(i, 0.5), b);
    assert.strictEqual(S.backoffDelay(i, 0), Math.round(b * 0.8));
    assert.strictEqual(S.backoffDelay(i, 1), Math.round(b * 1.2));
  });
  assert.strictEqual(S.MAX_ATTEMPTS, 12);
});

test('AI detection is structural, never by name', () => {
  const user = { id: 'someone', name: 'Someone' };
  assert.deepStrictEqual(J(S.classifyOpponents(user, { aiLevel: 3 })), { kind: 'ai', botColor: 'b' });
  assert.deepStrictEqual(J(S.classifyOpponents({ aiLevel: 8 }, user)), { kind: 'ai', botColor: 'w' });
  const bad = [
    [user, { id: 'stockfish', name: 'Stockfish' }],          // a human named stockfish
    [user, { ai: true }],                                     // ai flag without aiLevel
    [user, { aiLevel: '8' }],                                 // string level
    [user, { aiLevel: 0 }], [user, { aiLevel: 9 }], [user, { aiLevel: 2.5 }],
    [{ aiLevel: 1 }, { aiLevel: 2 }],                         // both AI
    [user, user],                                             // human vs human
    [user, null], [{}, { aiLevel: 3 }],
    [{ id: 'x', aiLevel: 3 }, { aiLevel: 3 }],
  ];
  for (const [w, b] of bad) assert.deepStrictEqual(J(S.classifyOpponents(w, b)), { kind: 'other' }, JSON.stringify([w, b]));
});

test('statuses: live, terminal (scalachess), unknown', () => {
  for (const s of ['created', 'started']) assert.strictEqual(S.classifyStatus(s), 'live');
  for (const s of ['aborted', 'mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime', 'cheat', 'noStart', 'unknownFinish', 'insufficientMaterialClaim', 'variantEnd'])
    assert.strictEqual(S.classifyStatus(s), 'terminal', s);
  for (const s of ['finished', '', 'STARTED', undefined, '<img src=x onerror=alert(1)>']) assert.strictEqual(S.classifyStatus(s), 'unknown', String(s));
});

test('variants: only standard and fromPosition', () => {
  assert.ok(S.isSupportedVariant('standard'));
  assert.ok(S.isSupportedVariant('fromPosition'));
  for (const v of ['chess960', 'crazyhouse', 'atomic', 'Standard', '']) assert.ok(!S.isSupportedVariant(v), v);
});

test('gameFull/gameState schema checks', () => {
  const full = { type: 'gameFull', id: 'i40iA4IQ', white: { id: 'u' }, black: { aiLevel: 1 }, variant: { key: 'standard' }, initialFen: 'startpos', state: { moves: '', status: 'started' } };
  assert.strictEqual(S.checkGameFull(full, 'i40iA4IQ'), null);
  assert.strictEqual(S.checkGameFull(full, 'OTHERIDX'), 'id');
  for (const patch of [{ id: 5 }, { white: null }, { variant: { name: 'x' } }, { initialFen: null }, { state: { moves: 1, status: 'started' } }, { state: { moves: '' } }])
    assert.strictEqual(S.checkGameFull(Object.assign({}, full, patch), 'i40iA4IQ'), 'schema', JSON.stringify(patch));
  assert.strictEqual(S.checkGameState({ type: 'gameState', moves: 'e2e4', status: 'started' }), null);
  assert.strictEqual(S.checkGameState({ type: 'gameState', moves: ['e2e4'], status: 'started' }), 'schema');
});

test('engine info lines are validated strictly', () => {
  const ok = S.parseEngineInfo('info depth 12 seldepth 18 multipv 2 score cp -35 nodes 1 nps 1 time 1 pv e7e5 g1f3');
  assert.deepStrictEqual(J(ok), { depth: 12, multipv: 2, cp: -35, move: 'e7e5' });
  assert.strictEqual(S.parseEngineInfo('info depth 20 score mate -3 pv a7a8q').mate, -3);
  assert.strictEqual(S.parseEngineInfo('info depth 20 score mate 2 pv a7a8q').move, 'a7a8q');
  for (const l of [
    'info depth 0 score cp 1 pv e2e4', 'info depth x score cp 1 pv e2e4', 'info depth 5 score cp 1.5 pv e2e4',
    'info depth 5 score cp 1 pv <img>', 'info depth 5 score cp 1 pv e2e9', 'info depth 5 score cp 1',
    'info string NNUE evaluation', 'info depth 5 multipv 0 score cp 1 pv e2e4', 'bestmove e2e4', 42,
    'info depth 5 score cp 99999999999 pv e2e4',
  ]) assert.strictEqual(S.parseEngineInfo(l), null, String(l));
  for (const m of ['e2e4', 'a7a8q', 'h2h1n']) assert.ok(S.UCI_MOVE_RE.test(m));
  for (const m of ['e2e4x', 'e2', 'i2i4', 'e2e4Q', '0-0']) assert.ok(!S.UCI_MOVE_RE.test(m));
});

test('board signature ignores drag/animation classes and ghosts', () => {
  const a = S.boardSignature([{ cls: 'white pawn', pos: 'translate(0px, 0px)' }, { cls: 'black king', pos: 'translate(64px, 0px)' }]);
  const b = S.boardSignature([{ cls: 'black king anim', pos: 'translate(64px, 0px)' }, { cls: 'pawn white dragging', pos: 'translate(0px, 0px)' }, { cls: 'white pawn ghost', pos: 'x' }]);
  assert.strictEqual(a, b);
  const c = S.boardSignature([{ cls: 'white pawn', pos: 'translate(0px, 64px)' }, { cls: 'black king', pos: 'translate(64px, 0px)' }]);
  assert.notStrictEqual(a, c);
});

test('HUD texts exist for every failure state (G23)', () => {
  for (const k of ['TXT_NO_TOKEN', 'TXT_CONSENT', 'TXT_NOT_DETECTED', 'TXT_INCONSISTENT', 'TXT_CONNECTING', 'TXT_RECONNECTING',
    'TXT_TOKEN_BAD', 'TXT_UNAVAILABLE', 'TXT_RATE_LIMIT', 'TXT_LOST', 'TXT_API_CHANGED', 'TXT_VS_HUMAN', 'TXT_VARIANT',
    'TXT_POSITION', 'TXT_ENG_FAILED', 'TXT_ENG_BUSY', 'TXT_STORAGE'])
    assert.ok(typeof S[k] === 'string' && S[k].length > 3, k);
});
