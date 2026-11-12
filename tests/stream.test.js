// G4 / U2 — the real read loop of content.js against a fake ReadableStream:
// HTTP classification, backoff, 429 cooldown, the shared budget of 12,
// budget reset rules, deadlines, buffer limit and the EOF tail.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadContent, streamResponse, ev, flush } = require('./helpers/env');

const TOKEN = 'lip_TESTTOKEN0000000000';
const ID = 'abcdefgh';

// Starts content.js on a game page; every stream request gets a fresh
// controllable response unless `reply` says otherwise.
async function game(reply, opts = {}) {
  const streams = [];
  const e = loadContent(Object.assign({
    url: 'https://lichess.org/game/' + ID,
    local: { token: TOKEN },
    setup: env => {
      env.gamePage();
      env.fetch.reply = call => {
        const r = reply ? reply(call, streams.length) : undefined;
        if (r !== undefined) return r;
        const s = streamResponse(200); streams.push(s); return s;
      };
    },
  }, opts));
  await flush(20);
  return { e, streams };
}
const analyzeMsgs = e => e.sent.filter(m => m.type === 'ENGINE_ANALYZE');

test('request shape: Bearer header, no redirects, no cookies, id only in the path', async () => {
  const { e } = await game();
  const c = e.streamCalls();
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].url, 'https://lichess.org/api/board/game/stream/' + ID);
  assert.strictEqual(c[0].opts.headers.Authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(c[0].opts.redirect, 'error');
  assert.strictEqual(c[0].opts.credentials, 'omit');
  assert.ok(!c[0].url.includes(TOKEN));
  assert.match(e.hudText(), /Connecting/);
});

test('gameFull → analysis of the replayed position; gameState → next position', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID, { state: { moves: 'e2e4 e7e5', status: 'started' } }));
  await flush(10);
  const a = analyzeMsgs(e);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].fen, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
  assert.strictEqual(a[0].session, e.get('session.gen'));
  streams[0].push(ev.state('e2e4 e7e5 g1f3'));
  await flush(10);
  assert.match(e.hudText(), /Opponent thinking/);   // black (AI) to move
  streams[0].push(ev.state('e2e4 e7e5 g1f3 b8c6'));
  await flush(10);
  assert.strictEqual(analyzeMsgs(e).length, 2);
});

test('EOF does not throw and reconnects after the first backoff step (3 s)', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID));
  streams[0].end();
  await flush(10);
  assert.deepStrictEqual(e.clock.errors, []);
  assert.match(e.hudText(), /Reconnecting/);
  await e.clock.advance(2900);
  assert.strictEqual(e.streamCalls().length, 1);
  await e.clock.advance(200);
  assert.strictEqual(e.streamCalls().length, 2);
});

test('last line without "\\n" is parsed at EOF; a cut-off fragment is dropped', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID));
  streams[0].push(ev.state('e2e4').trim());   // no trailing newline
  streams[0].end();
  await flush(10);
  assert.ok(analyzeMsgs(e).length >= 1);
  assert.strictEqual(e.get('session.moves'), 'e2e4');
  const g2 = await game();
  g2.streams[0].push(ev.full(ID));
  g2.streams[0].push('{"type":"gameSta');
  g2.streams[0].end();
  await flush(10);
  assert.match(g2.e.hudText(), /Reconnecting/);
});

for (const [status, re] of [[401, /Token invalid/], [403, /Token invalid/], [404, /Game unavailable/], [400, /Lichess API changed/]]) {
  test(`HTTP ${status}: one request, clear HUD, no retries`, async () => {
    const { e } = await game(() => status);
    assert.match(e.hudText(), re);
    await e.clock.advance(10 * 60 * 1000);
    assert.strictEqual(e.streamCalls().length, 1);
  });
}

test('5xx and network errors back off 3/5/8 s', async () => {
  let n = 0;
  const { e } = await game(() => (++n % 2 ? 503 : new TypeError('network')));
  const times = [];
  for (let t = 0; t < 20000; t += 100) { const before = e.streamCalls().length; await e.clock.advance(100); if (e.streamCalls().length > before) times.push(t + 100); }
  assert.deepStrictEqual(times, [3000, 8000, 16000]);
});

test('429: waits max(60 s, Retry-After); the cooldown is shared and never bypassed', async () => {
  let n = 0;
  const { e } = await game(() => (++n === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '120' } }) : undefined));
  assert.match(e.hudText(), /rate limit[\s\S]*Retrying in 120 s/);
  await e.clock.advance(119000);
  assert.strictEqual(e.streamCalls().length, 1);
  e.toContent({ type: 'HINT_SHOW' });            // UI actions do not bypass the cooldown
  e.fireMutations();
  await e.clock.advance(500);
  assert.strictEqual(e.streamCalls().length, 1);
  await e.clock.advance(1000);
  assert.strictEqual(e.streamCalls().length, 2);
});

test('a series of 429 spends the budget of 12, then stops; a click waits for the cooldown', async () => {
  const { e } = await game(() => 429);
  await e.clock.advance(12 * 61000);
  assert.strictEqual(e.streamCalls().length, 12);
  assert.match(e.hudText(), /Connection lost/);
  await e.clock.advance(60 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 12, 'no automatic requests after the budget');
  e.hud().dispatch('click');                     // within the last cooldown? no: it expired; one new request
  await flush(10);
  assert.strictEqual(e.streamCalls().length, 13);
  // that one was a 429 again: a click now must wait for the cooldown
  e.hud().dispatch('click');
  await flush(10);
  assert.strictEqual(e.streamCalls().length, 13);
  assert.match(e.hudText(), /rate limit/);
});

test('gameFull → same snapshot → EOF on every connect does not reset the budget', async () => {
  const { e, streams } = await game((c, i) => { const s = streamResponse(200); setImmediate(() => { s.push(ev.full(ID, { state: { moves: 'e2e4', status: 'started' } })); s.push(ev.state('e2e4')); s.end(); }); return s; });
  await e.clock.advance(15 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 12);
  assert.match(e.hudText(), /Connection lost/);
  void streams;
});

test('a genuinely new gameState resets the budget', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID));
  await flush(10);
  e.get('session.attempts = 11');
  streams[0].push(ev.state('e2e4'));
  await flush(10);
  assert.strictEqual(e.get('session.attempts'), 0);
});

test('replayed full/state pairs across reconnects cannot renew the budget forever', async () => {
  const { e } = await game(() => {
    const s = streamResponse(200);
    setImmediate(() => { s.push(ev.full(ID)); s.push(ev.state('e2e4')); s.end(); });
    return s;
  });
  await e.clock.advance(15 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 13, 'one useful update, then twelve attempts');
  assert.match(e.hudText(), /Connection lost/);
});

test('invalid moves do not restore the retry budget', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID)); await flush(10);
  e.get('session.attempts = 11');
  streams[0].push(ev.state('e2e5')); await flush(10);
  assert.strictEqual(e.get('session.attempts'), 11);
  assert.match(e.hudText(), /Position unavailable/);
});

test('oversized newline-terminated NDJSON is rejected before JSON handling', async () => {
  for (const text of ['x'.repeat(1024 * 1024), '界'.repeat(400000)]) {
    const { e, streams } = await game();
    streams[0].push(ev.full(ID)); await flush(10);
    streams[0].push(JSON.stringify({ type: 'chatLine', text }) + '\n');
    await flush(10);
    assert.match(e.hudText(), /Lichess API changed/);
    assert.ok(streams[0].closed);
  }
});

test('malformed first event at EOF is a terminal API error', async () => {
  const { e, streams } = await game();
  streams[0].push('<html>maintenance</html>'); streams[0].end();
  await flush(10);
  assert.match(e.hudText(), /Lichess API changed/);
  await e.clock.advance(60000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('a stream that stays up 30 s restores the budget', async () => {
  const { e, streams } = await game();
  e.ctx.__clock; // keep reference
  streams[0].push(ev.full(ID));
  await flush(10);
  e.get('session.attempts = 11');
  await e.clock.advance(31000);
  assert.strictEqual(e.get('session.attempts'), 0);
});

test('no gameFull within 15 s → retry', async () => {
  const { e } = await game();
  await e.clock.advance(14900);
  assert.strictEqual(e.streamCalls().length, 1);
  await e.clock.advance(200 + 3000);
  assert.strictEqual(e.streamCalls().length, 2);
});

test('60 s without any byte → retry; keepalive lines count as bytes', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID));
  for (let i = 0; i < 10; i++) { await e.clock.advance(50000); streams[0].push('\n'); await flush(); }
  assert.strictEqual(e.streamCalls().length, 1);
  await e.clock.advance(60100 + 3000);
  assert.strictEqual(e.streamCalls().length, 2);
});

test('first event that is not JSON → "Lichess API changed", no retries', async () => {
  const { e, streams } = await game();
  streams[0].push('<html>maintenance</html>\n');
  await flush(10);
  assert.match(e.hudText(), /Lichess API changed/);
  await e.clock.advance(10 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('first event of another type, wrong game id, unknown status → "Lichess API changed"', async () => {
  for (const first of [ev.state('e2e4'), ev.full('zzzzzzzz'), ev.full(ID, { state: { moves: '', status: 'paused' } }), ev.full(ID, { variant: 'standard' })]) {
    const { e, streams } = await game();
    streams[0].push(first);
    await flush(10);
    assert.match(e.hudText(), /Lichess API changed/, first);
    await e.clock.advance(5 * 60 * 1000);
    assert.strictEqual(e.streamCalls().length, 1);
    assert.strictEqual(analyzeMsgs(e).length, 0);
  }
});

test('unterminated line over 1 MB → abort with "Lichess API changed"', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID));
  const chunk = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 5; i++) streams[0].push(chunk);
  await flush(20);
  assert.match(e.hudText(), /Lichess API changed/);
  assert.ok(streams[0].closed, 'request aborted');
});

test('terminal status ends the session: no reconnect, engine stopped', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID, { state: { moves: 'e2e4 e7e5', status: 'started' } }));
  await flush(10);
  streams[0].push(ev.state('e2e4 e7e5 d1h5', 'resign'));
  await flush(10);
  assert.match(e.hudText(), /Game over: resign/);
  assert.ok(e.sent.some(m => m.type === 'ENGINE_STOP'));
  await e.clock.advance(10 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('hidden tab: retries wait until the tab is visible again', async () => {
  const { e, streams } = await game();
  streams[0].push(ev.full(ID)); streams[0].end();
  await flush(10);
  e.document.visibilityState = 'hidden';
  await e.clock.advance(60000);
  assert.strictEqual(e.streamCalls().length, 1);
  e.document.visibilityState = 'visible';
  e.document.dispatch('visibilitychange');
  await flush(10);
  assert.strictEqual(e.streamCalls().length, 2);
});
