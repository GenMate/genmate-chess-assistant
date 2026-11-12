// G21 / U4 — data consent in the background page: Firefox 140+ permission
// grant vs. local record on older Firefox, fail-closed errors, who may record
// a decision, and the one-time data settings tab after install/update.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadBackground, flush, J } = require('./helpers/env');

const TOKEN = 'lip_TESTTOKEN0000000000';
const state = async (b, sender) => (await b.send({ type: 'CONSENT_GET' }, sender || b.contentSender(7))).state;

test('revocation stops and broadcasts before any slow storage read', async () => {
  const b = loadBackground({ granted: true }); await flush(20);
  b.connectTab(7);
  await b.send({ type: 'ENGINE_ANALYZE', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', session: 1, jobId: 1, infinite: true, multiPv: 1, movetime: 3000 }, b.contentSender(7));
  b.local.get = () => new Promise(() => {});
  b.perms.granted = false;
  b.permRemoved.fns.forEach(f => f({ data_collection: ['authenticationInfo'] }));
  assert.ok(b.worker().posted.includes('stop'));
  assert.ok(b.linesTo(7).some(m => m.type === 'CONSENT_CHANGED'));
});

test('manifest declares optional categories, required none, minimum 109', () => {
  const m = JSON.parse(require('fs').readFileSync(require('path').join(require('./helpers/env').EXT, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(m.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'], optional: ['authenticationInfo', 'browsingActivity'] });
  assert.strictEqual(m.browser_specific_settings.gecko.strict_min_version, '109.0');
  assert.strictEqual(m.browser_specific_settings.gecko.id, 'chess-assistant@genmate');
});

test('modern Firefox: browser grant is the source of truth', async () => {
  const b = loadBackground({ modern: true, granted: false });
  await flush(10);
  assert.strictEqual(await state(b), 'undecided');
  b.perms.granted = true;
  assert.strictEqual(await state(b), 'granted');
});

test('modern Firefox: a local "yes" from an older Firefox does not replace the browser grant', async () => {
  const b = loadBackground({ modern: true, granted: false, local: { consent: { v: 1, game: true, at: 1 } } });
  await flush(10);
  assert.strictEqual(await state(b), 'denied');
});

test('legacy Firefox (no data_collection): local record decides', async () => {
  const b = loadBackground({ modern: false });
  await flush(10);
  assert.strictEqual(await state(b), 'undecided');
  assert.deepStrictEqual(J(await b.send({ type: 'CONSENT_SET', game: true }, b.pageSender('consent.html'))), { ok: true });
  assert.strictEqual(await state(b), 'granted');
  await b.send({ type: 'CONSENT_SET', game: false }, b.pageSender('consent.html'));
  assert.strictEqual(await state(b), 'denied');
});

test('fail closed: permissions/storage errors never mean "granted" nor "legacy"', async () => {
  const b = loadBackground({ modern: true, granted: true });
  await flush(10);
  b.perms.failGetAll = true;
  assert.strictEqual(await state(b), 'error');
  b.perms.failGetAll = false; b.perms.failContains = true;
  assert.strictEqual(await state(b), 'error');
  b.perms.failContains = false; b.local.failGet = true;
  assert.strictEqual(await state(b), 'error', 'modern grant cannot bypass storage failure');
  const l = loadBackground({ modern: false, local: { consent: { v: 1, game: true } }, localOpts: { failGet: true } });
  await flush(10);
  assert.strictEqual(await state(l), 'error');
});

test('only consent.html may record a decision (U4)', async () => {
  const b = loadBackground({ modern: false });
  await flush(10);
  assert.strictEqual(await b.send({ type: 'CONSENT_SET', game: true }, b.contentSender(7)), undefined);
  assert.strictEqual(await b.send({ type: 'CONSENT_SET', game: true }, b.pageSender('popup.html')), undefined);
  assert.strictEqual(await b.send({ type: 'CONSENT_SET', game: true }, { id: 'chess-assistant@genmate', url: 'https://lichess.org/x', tab: { id: 1, url: 'moz-extension://test-uuid/consent.html' } }), undefined);
  assert.strictEqual(await b.send({ type: 'CONSENT_SET', game: 'yes' }, b.pageSender('consent.html')), undefined);
  assert.strictEqual(await state(b), 'undecided');
});

test('install and update (with and without a 1.1.0 token) open the settings tab once; nothing is sent', async () => {
  for (const reason of ['install', 'update']) {
    for (const sync of [{}, { token: TOKEN }]) {
      const b = loadBackground({ modern: true, sync });
      await flush(10);
      b.onInstalled.fns.forEach(f => f({ reason }));
      await flush(20);
      assert.deepStrictEqual(J(b.created), [{ url: 'moz-extension://test-uuid/consent.html', active: true }], reason);
      assert.strictEqual(b.local.data.consentShown, 1);
      b.onInstalled.fns.forEach(f => f({ reason }));
      await flush(20);
      assert.strictEqual(b.created.length, 1, 'not opened again');
      assert.strictEqual(b.fetch.calls.filter(c => /lichess\.org/.test(c.url)).length, 0);
    }
  }
});

test('no tab when a decision already exists or the grant is present; browser_update is ignored', async () => {
  const a = loadBackground({ modern: false, local: { consent: { v: 1, game: false } } });
  await flush(10); a.onInstalled.fns.forEach(f => f({ reason: 'update' })); await flush(20);
  assert.strictEqual(a.created.length, 0);
  const g = loadBackground({ modern: true, granted: true });
  await flush(10); g.onInstalled.fns.forEach(f => f({ reason: 'update' })); await flush(20);
  assert.strictEqual(g.created.length, 0);
  const u = loadBackground({ modern: true });
  await flush(10); u.onInstalled.fns.forEach(f => f({ reason: 'browser_update' })); await flush(20);
  assert.strictEqual(u.created.length, 0);
});

test('revocation stops engine searches and tells every tab', async () => {
  const b = loadBackground({ modern: true, granted: true });
  await flush(10);
  b.connectTab(7);
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  await b.send({ type: 'ENGINE_ANALYZE', fen, session: 1, jobId: 1, infinite: true, multiPv: 1, movetime: 3000 }, b.contentSender(7));
  await flush(10);
  b.perms.granted = false;
  b.permRemoved.fns.forEach(f => f({ data_collection: ['authenticationInfo'] }));
  await flush(20);
  assert.ok(b.worker().posted.includes('stop'));
  assert.ok(b.linesTo(7).some(m => m.type === 'CONSENT_CHANGED'));
});

test('content may ask to open the fixed settings page, nothing else', async () => {
  const b = loadBackground();
  await flush(10);
  await b.send({ type: 'OPEN_CONSENT', url: 'https://evil.example/' }, b.contentSender(7));
  assert.deepStrictEqual(J(b.created), [{ url: 'moz-extension://test-uuid/consent.html', active: true }]);
});
