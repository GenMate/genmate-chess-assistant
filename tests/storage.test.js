// G10 / W3 / U6 — settings storage: local first, legacy sync read-only,
// tombstone, no sync writes, visible failures, "Remove token" both copies.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCommon, loadBackground, flush, J } = require('./helpers/env');

const TOKEN = 'lip_TESTTOKEN0000000000';

test('local value wins over legacy sync value', async () => {
  const c = loadCommon({ local: { token: 'lip_TESTTOKENlocal', mode: 'timed' }, sync: { token: TOKEN, mode: 'infinite', multiPv: 2 } });
  const s = J(await c.loadSettings());
  assert.strictEqual(s.token, 'lip_TESTTOKENlocal');
  assert.strictEqual(s.mode, 'timed');
  assert.strictEqual(s.multiPv, 2);           // only in sync → legacy value read
  assert.strictEqual(s.showEval, true);       // nowhere → default
});

test('legacy 1.1.0 token in sync is still read when local has none', async () => {
  const c = loadCommon({ sync: { token: TOKEN } });
  assert.strictEqual((await c.loadSettings()).token, TOKEN);
});

test('empty local token is a tombstone: the sync token is not resurrected', async () => {
  const c = loadCommon({ local: { token: '' }, sync: { token: TOKEN } });
  assert.strictEqual((await c.loadSettings()).token, '');
});

test('saveSettings writes local only, never sync', async () => {
  const c = loadCommon({ sync: { token: TOKEN } });
  await c.saveSettings({ token: 'lip_TESTTOKENnew', mode: 'timed' });
  assert.strictEqual(c.local.data.token, 'lip_TESTTOKENnew');
  assert.strictEqual(c.sync.setCalls.length, 0);
  assert.strictEqual(c.sync.data.token, TOKEN);
});

test('storage.local read failure is an error (callers show "storage unavailable")', async () => {
  const c = loadCommon({ localOpts: { failGet: true }, sync: { token: TOKEN } });
  await assert.rejects(c.loadSettings());
});

test('storage.local write failure is visible (rejects)', async () => {
  const c = loadCommon({ localOpts: { failSet: true } });
  await assert.rejects(c.saveSettings({ token: 'lip_TESTTOKENx' }));
  assert.strictEqual(c.sync.setCalls.length, 0);
});

test('sync read failure only means "no legacy values"', async () => {
  const c = loadCommon({ syncOpts: { failGet: true }, local: { mode: 'timed' } });
  const s = await c.loadSettings();
  assert.strictEqual(s.mode, 'timed');
  assert.strictEqual(s.token, '');
});

test('malformed stored values fall back to defaults', async () => {
  const c = loadCommon({ local: { token: 5, mode: 'evil', movetime: -1, multiPv: '2', hintMode: '<b>' } });
  const s = J(await c.loadSettings());
  assert.deepStrictEqual([s.token, s.mode, s.movetime, s.multiPv, s.hintMode], ['', 'infinite', 3000, 2, 'origin']);
});

test('Remove token: local tombstone first, then sync copy removed; other sync keys kept', async () => {
  const c = loadCommon({ local: { token: 'lip_TESTTOKENlocal' }, sync: { token: TOKEN, mode: 'timed' } });
  const r = J(await c.removeToken());
  assert.deepStrictEqual(r, { local: true, sync: true });
  assert.strictEqual(c.local.data.token, '');
  assert.ok(!('token' in c.sync.data));
  assert.strictEqual(c.sync.data.mode, 'timed');
  assert.deepStrictEqual(J(c.sync.removeCalls), ['token']);
  assert.strictEqual(c.sync.setCalls.length, 0);
});

test('Remove token: sync failure keeps the tombstone and reports incomplete removal', async () => {
  const c = loadCommon({ sync: { token: TOKEN }, syncOpts: { failRemove: true } });
  assert.deepStrictEqual(J(await c.removeToken()), { local: true, sync: false });
  assert.strictEqual(c.local.data.token, '');
  assert.strictEqual((await c.loadSettings()).token, '');
});

test('Remove token: local failure stops before touching sync', async () => {
  const c = loadCommon({ sync: { token: TOKEN }, localOpts: { failSet: true } });
  assert.deepStrictEqual(J(await c.removeToken()), { local: false, sync: null });
  assert.strictEqual(c.sync.removeCalls.length, 0);
});

test('background startup never writes to storage.sync', async () => {
  const b = loadBackground({ sync: { token: TOKEN, engine: 'lite', mode: 'timed' } });
  await flush(20);
  assert.strictEqual(b.sync.setCalls.length, 0);
  assert.strictEqual(b.local.setCalls.length, 0);
});

test('background rejects messages from other extensions and from non-Lichess pages', async () => {
  const b = loadBackground();
  await flush(20);
  assert.strictEqual(await b.send({ type: 'ENGINE_STATUS' }, { id: 'other@ext', url: 'moz-extension://x/popup.html' }), undefined);
  const evil = { id: 'chess-assistant@genmate', url: 'https://evil.example/', tab: { id: 3, url: 'https://evil.example/' } };
  assert.strictEqual(await b.send({ type: 'ENGINE_ANALYZE', fen: 'x' }, evil), undefined);
  assert.strictEqual(await b.send({ type: 'GET_SETTINGS' }, b.pageSender('popup.html')), undefined, 'GET_SETTINGS removed');
});

// Public MultiPV expansion and the new-install default must survive normalization.
test('three PV lines survive save/load; origin is the default but saved piece mode is preserved', async () => {
  const fresh = loadCommon();
  assert.strictEqual((await fresh.loadSettings()).hintMode, 'origin');
  await fresh.saveSettings({ multiPv: 3 });
  assert.strictEqual((await fresh.loadSettings()).multiPv, 3);
  const existing = loadCommon({ local: { hintMode: 'piece', multiPv: 2 } });
  const settings = await existing.loadSettings();
  assert.strictEqual(settings.hintMode, 'piece');
  assert.strictEqual(settings.multiPv, 2);
});

test('two lines are the new default; explicit saved one-line choice is retained', async () => {
  assert.strictEqual((await loadCommon().loadSettings()).multiPv, 2);
  assert.strictEqual((await loadCommon({local:{multiPv:1}}).loadSettings()).multiPv, 1);
});
