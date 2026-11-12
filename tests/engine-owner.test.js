// G11 / U3 — one worker, strict ownership {tabId, session, jobId}, stop
// barrier, start failures, preemption without automatic recapture.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadBackground, flush } = require('./helpers/env');

const FEN1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const FEN2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const job = (fen, session, jobId, extra) => Object.assign({ type: 'ENGINE_ANALYZE', fen, session, jobId, infinite: true, multiPv: 1, movetime: 3000 }, extra || {});

async function ready(opts) {
  const b = loadBackground(opts);
  await flush(20);
  return b;
}
const lines = (b, tab) => b.linesTo(tab).filter(m => m.type === 'ENGINE_LINE');

test('engine starts and a search runs for its owner only', async () => {
  const b = await ready();
  b.connectTab(1); b.connectTab(2);
  const r = await b.send(job(FEN1, 5, 1), b.contentSender(1));
  assert.deepStrictEqual({ ok: r.ok, ready: r.ready }, { ok: true, ready: true });
  const w = b.worker();
  assert.ok(w.posted.includes('position fen ' + FEN1));
  assert.ok(w.posted.includes('go infinite'));
  w.emit('info depth 5 multipv 1 score cp 20 pv e7e5');
  await flush();
  assert.deepStrictEqual(lines(b, 1).map(m => [m.session, m.jobId, m.line]), [[5, 1, 'info depth 5 multipv 1 score cp 20 pv e7e5']]);
  assert.strictEqual(lines(b, 2).length, 0);
});

test('two tabs with the same local jobId: output never crosses; late lines of the old search are dropped', async () => {
  const b = await ready({ workerAuto: { uciok: true, readyok: true, stopReplies: false } });
  b.connectTab(1); b.connectTab(2);
  await b.send(job(FEN1, 3, 1), b.contentSender(1));
  const w = b.worker();
  w.emit('info depth 4 score cp 10 pv e7e5');
  await b.send(job(FEN2, 3, 1), b.contentSender(2));        // same session/jobId numbers, other tab
  assert.ok(w.posted.includes('stop'));
  assert.ok(b.linesTo(1).some(m => m.type === 'ENGINE_PREEMPTED'), 'tab 1 told it was displaced');
  w.emit('info depth 9 score cp 99 pv d7d5');                // late output of the old search
  w.emit('bestmove d7d5');                                   // end of the old search (barrier)
  await flush();
  assert.ok(w.posted.includes('position fen ' + FEN2));
  w.emit('info depth 6 score cp 30 pv g1f3');
  await flush();
  assert.deepStrictEqual(lines(b, 1).map(m => m.line), ['info depth 4 score cp 10 pv e7e5']);
  assert.deepStrictEqual(lines(b, 2).map(m => m.line), ['info depth 6 score cp 30 pv g1f3']);
});

test('the displaced tab does not take the engine back by itself', async () => {
  const b = await ready();
  b.connectTab(1); b.connectTab(2);
  await b.send(job(FEN1, 1, 1), b.contentSender(1));
  await b.send(job(FEN2, 1, 1), b.contentSender(2));
  await flush();
  const before = b.worker().posted.length;
  await b.clock.advance(60000);
  assert.strictEqual(b.worker().posted.length, before, 'no commands without a new request');
});

test('STOP from a non-owner is ignored; STOP from the owner stops', async () => {
  const b = await ready({ workerAuto: { uciok: true, readyok: true, stopReplies: false } });
  b.connectTab(1); b.connectTab(2);
  await b.send(job(FEN1, 4, 2), b.contentSender(1));
  const w = b.worker();
  await b.send({ type: 'ENGINE_STOP', session: 4, jobId: 2 }, b.contentSender(2));
  assert.ok(!w.posted.includes('stop'));
  await b.send({ type: 'ENGINE_STOP', session: 99, jobId: 2 }, b.contentSender(1));
  assert.ok(!w.posted.includes('stop'), 'other session of the same tab');
  await b.send({ type: 'ENGINE_STOP', session: 4, jobId: 1 }, b.contentSender(1));
  assert.ok(!w.posted.includes('stop'), 'stale job of the same session');
  await b.send({ type: 'ENGINE_STOP', session: 4, jobId: 2 }, b.contentSender(1));
  assert.ok(w.posted.includes('stop'));
});

test('obsolete port disconnect cannot stop a replacement connection in the same tab', async () => {
  const b = await ready();
  const old = b.connectTab(1);
  const current = b.connectTab(1);
  await b.send(job(FEN1, 2, 1), b.contentSender(1));
  old.disconnect();
  assert.ok(!b.worker().posted.includes('stop'));
  current.disconnect();
  assert.ok(b.worker().posted.includes('stop'));
});

test('repeated ready-then-crash without useful results exhausts the engine retry budget', async () => {
  const b = await ready();
  b.connectTab(1);
  await b.send(job(FEN1, 1, 1), b.contentSender(1));
  for (let i = 0; i < 3; i++) {
    b.worker().onerror({});
    await b.clock.advance(1100);
  }
  assert.ok(b.linesTo(1).some(m => m.type === 'ENGINE_ERROR'));
  const r = await b.send(job(FEN1, 1, 2), b.contentSender(1));
  assert.strictEqual(r.ok, false);
});

test('closing the owner tab stops its search', async () => {
  const b = await ready({ workerAuto: { uciok: true, readyok: true, stopReplies: false } });
  const t1 = b.connectTab(1); b.connectTab(2);
  await b.send(job(FEN1, 1, 1), b.contentSender(1));
  t1.disconnect();
  assert.ok(b.worker().posted.includes('stop'));
});

test('a stuck stop barrier (> 2 s) terminates and restarts the worker; queued search runs on the new one', async () => {
  const b = await ready({ workerAuto: { uciok: true, readyok: true, stopReplies: false } });
  b.connectTab(1);
  await b.send(job(FEN1, 1, 1), b.contentSender(1));
  const w1 = b.worker();
  await b.send(job(FEN2, 1, 2), b.contentSender(1));
  await b.clock.advance(2100);
  await flush(10);
  assert.ok(w1.terminated);
  const w2 = b.worker();
  assert.notStrictEqual(w1, w2);
  assert.ok(w2.posted.includes('position fen ' + FEN2));
  w1.onmessage && w1.onmessage({ data: 'info depth 30 score cp 1 pv a7a6' });   // old worker callback
  await flush();
  assert.ok(!b.linesTo(1).some(m => /a7a6/.test(m.line || '')));
});

test('same FEN while the same search runs → owner updated, no restart; after bestmove → new search', async () => {
  const b = await ready();
  b.connectTab(1);
  await b.send(job(FEN1, 1, 1), b.contentSender(1));
  const w = b.worker();
  const n = w.posted.filter(c => c.startsWith('go')).length;
  await b.send(job(FEN1, 1, 2), b.contentSender(1));
  assert.strictEqual(w.posted.filter(c => c.startsWith('go')).length, n, 'no new go');
  w.emit('info depth 3 score cp 1 pv e7e5');
  await flush();
  assert.strictEqual(lines(b, 1).pop().jobId, 2, 'lines go to the new jobId');
  w.emit('bestmove e7e5');
  await b.send(job(FEN1, 1, 3), b.contentSender(1));
  assert.strictEqual(w.posted.filter(c => c.startsWith('go')).length, n + 1, 'finished search is not reused');
});

test('different parameters on the same FEN start a new search', async () => {
  const b = await ready();
  b.connectTab(1);
  await b.send(job(FEN1, 1, 1), b.contentSender(1));
  const w = b.worker();
  await b.send(job(FEN1, 1, 2, { multiPv: 2 }), b.contentSender(1));
  await flush();
  assert.ok(w.posted.includes('setoption name MultiPV value 2'));
});

test('uciok timeout (30 s): three failed starts → ENGINE_ERROR and {ok:false}; retry flag resets', async () => {
  const b = await ready({ workerAuto: { uciok: false } });
  b.connectTab(1);
  let r = await b.send(job(FEN1, 1, 1), b.contentSender(1));
  assert.strictEqual(r.ready, false);
  await b.clock.advance(29000);
  assert.ok(!b.linesTo(1).some(m => m.type === 'ENGINE_ERROR'), 'a slow start is not killed before 30 s');
  for (let i = 0; i < 4; i++) await b.clock.advance(31000);
  assert.ok(b.linesTo(1).some(m => m.type === 'ENGINE_ERROR'));
  r = await b.send(job(FEN1, 1, 2), b.contentSender(1));
  assert.deepStrictEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'engine' });
  const count = b.FakeWorker.instances.length;
  r = await b.send(job(FEN1, 1, 3, { retry: true }), b.contentSender(1));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(b.FakeWorker.instances.length, count + 1, 'click starts a fresh worker');
});

test('malformed ENGINE_ANALYZE is rejected', async () => {
  const b = await ready();
  for (const bad of [job('rm -rf /', 1, 1), job(FEN1, 0, 1), job(FEN1, 1, 1, { multiPv: 9 }), job(FEN1, 1, 1, { movetime: 'x' }), job(FEN1, 1, 1, { infinite: 'yes' })]) {
    const r = await b.send(bad, b.contentSender(1));
    assert.deepStrictEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'bad-message' }, JSON.stringify(bad));
  }
});

test('engine files: lite worker is used; both .js and .wasm are probed for the full engine', async () => {
  const b = await ready();
  assert.ok(/sf-lite-worker\.js$/.test(b.worker().url));
  assert.strictEqual(await b.get('enginePresent("lite")'), true);
  assert.strictEqual(await b.get('enginePresent("full")'), false, 'empty 200 response is not a file');
  const f = await ready({ fullPresent: true });
  assert.strictEqual(await f.get('enginePresent("full")'), true);
});

test('idle unload is armed when the engine starts', async () => {
  const b = await ready();
  const w = b.worker();
  await b.clock.advance(10 * 60 * 1000 + 10);
  assert.ok(w.terminated);
});

test('Full selection switches the worker, resumes the owner job and supports three lines', async () => {
  const b = await ready({ fullPresent: true });
  await b.send(job(FEN1, 5, 1, { multiPv: 3 }), b.contentSender(1));
  const old = b.worker();
  const r = await b.send({ type: 'ENGINE_SWITCH', engine: 'full' }, b.pageSender('popup.html'));
  await flush(20);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.engine, 'full');
  assert.ok(old.terminated);
  assert.match(b.worker().url, /sf-full-worker/);
  assert.ok(b.worker().posted.includes('setoption name MultiPV value 3'));
  b.worker().emit('info depth 5 multipv 3 score cp 20 pv e7e5');
  assert.ok(lines(b, 1).some(m => m.session === 5 && m.jobId === 1));
  assert.strictEqual((await b.send({ type: 'GET_ENGINE' }, b.pageSender('popup.html'))).fullAvailable, true);
  await b.send({ type: 'ENGINE_SWITCH', engine: 'lite' }, b.pageSender('popup.html')); await flush(20);
  assert.match(b.worker().url, /sf-lite-worker/);
});

test('missing Full is an explicit failure and leaves Lite selected', async () => {
  const b = await ready(); const before = b.worker();
  const r = await b.send({ type: 'ENGINE_SWITCH', engine: 'full' }, b.pageSender('popup.html'));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'unavailable');
  assert.strictEqual(r.engine, 'lite'); assert.strictEqual(b.worker(), before);
});

test('Full startup failure never silently selects Lite', async () => {
  const b = await ready({ fullPresent: true, local: { engine: 'full' }, workerAuto: { uciok: false } });
  await b.clock.advance(100000);
  const r = await b.send({ type: 'GET_ENGINE' }, b.pageSender('popup.html'));
  assert.strictEqual(r.engine, 'full');
  assert.strictEqual(b.local.data.engine, 'full');
});
