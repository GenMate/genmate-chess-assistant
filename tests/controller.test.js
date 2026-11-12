// G2 / G3 / G5 / G7 / G8 / G12 / G21 / G23 / U1 / U3 / U4 — content.js
// controller with a fake DOM, fake fetch and fake clock: page contexts,
// session lifecycle, late promises, pause, consent, board signal, safe HUD.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadContent, streamResponse, ev, flush } = require('./helpers/env');

const TOKEN = 'lip_TESTTOKEN0000000000';
const ID = 'abcdefgh';
const B = 'https://lichess.org';

async function page(url, opts = {}) {
  const streams = [];
  const e = loadContent(Object.assign({
    url, local: { token: TOKEN },
    setup: env => {
      if (opts.markup !== null) env.gamePage(opts.markup || {});
      env.fetch.reply = () => { const s = streamResponse(200); streams.push(s); return s; };
      if (opts.setup) opts.setup(env);
    },
  }, opts.load || {}));
  await flush(20);
  return { e, streams };
}
const analyzeMsgs = e => e.sent.filter(m => m.type === 'ENGINE_ANALYZE');

test('consent change aborts the old stream before a delayed consent reply', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  e.bgReply = m => m.type === 'CONSENT_GET' ? new Promise(() => {}) : undefined;
  e.toContent({ type: 'CONSENT_CHANGED' });
  assert.ok(streams[0].closed);
  await flush(10);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('late settings snapshot cannot resurrect a removed token', async () => {
  const { e } = await page(B + '/game/' + ID);
  const get = e.local.get;
  const snapshot = await get(null);
  let release;
  e.local.get = () => { e.local.get = get; return new Promise(r => { release = () => r(snapshot); }); };
  e.toContent({ type: 'SETTINGS_CHANGED' });
  await flush();
  await e.local.set({ token: '' }); await flush(10);
  release(); await flush(10);
  assert.strictEqual(e.get('cfg.token'), '');
  e.location.href = B + '/game/ijklmnop';
  await e.clock.advance(1100);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('duplicate stream snapshot cannot recapture a preempted worker', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID)); await flush(10);
  const job = analyzeMsgs(e)[0];
  e.toContent({ type: 'ENGINE_PREEMPTED', session: job.session, jobId: job.jobId });
  streams[0].push(ev.state('')); await flush(10);
  assert.strictEqual(analyzeMsgs(e).length, 1);
  assert.match(e.hudText(), /Engine busy/);
  e.hud().dispatch('click'); await flush(10);
  assert.strictEqual(analyzeMsgs(e).length, 2);
});

// ---------------------------------------------------------------- contexts
test('TV and other known non-game pages: no HUD, no request', async () => {
  for (const [url, markup] of [[B + '/tv', {}], [B + '/' + ID, { tv: true }], [B + '/analysis', {}], [B + '/training/x', {}], [B + '/@/GenMate', {}]]) {
    const { e } = await page(url, { markup });
    await e.clock.advance(5000);
    assert.strictEqual(e.fetch.calls.length, 0, url);
    assert.ok(!e.hudVisible(), url);
  }
});

test('page with a board but no id: "Game not detected", no request', async () => {
  const { e } = await page(B + '/some/new/game/path');
  assert.match(e.hudText(), /Game not detected/);
  await e.clock.advance(5000);
  assert.strictEqual(e.fetch.calls.length, 0);
});

test('page without game markup and without id: hidden', async () => {
  const { e } = await page(B + '/some/page', { markup: null });
  assert.ok(!e.hudVisible());
  assert.strictEqual(e.fetch.calls.length, 0);
});

test('id from og:url when the URL has none', async () => {
  const { e } = await page(B + '/some/new/game/path', { markup: { og: B + '/game/' + ID } });
  assert.strictEqual(e.streamCalls().length, 1);
  assert.ok(e.streamCalls()[0].url.endsWith('/' + ID));
});

test('URL id ≠ page metadata: no request; after > 2 s "Game information is inconsistent"', async () => {
  const { e } = await page(B + '/game/' + ID, { markup: { og: B + '/game/zzzzzzzz' } });
  assert.strictEqual(e.fetch.calls.length, 0);
  await e.clock.advance(2600);
  assert.match(e.hudText(), /inconsistent/);
  assert.strictEqual(e.fetch.calls.length, 0);
});

test('conflict appearing during a session cancels the stream (U1)', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID));
  await flush(10);
  const m = e.document.createElement('meta'); m.attrs.content = B + '/game/zzzzzzzz';
  e.document.selectors['meta[property="og:url"]'] = m;
  await e.clock.advance(1000);
  assert.ok(streams[0].closed, 'stream aborted');
  await e.clock.advance(5000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('late board / late markup on the same URL → exactly one session', async () => {
  const { e } = await page(B + '/game/' + ID, { markup: null });
  assert.strictEqual(e.streamCalls().length, 1);    // URL id is enough
  e.gamePage();
  e.fireMutations();
  await e.clock.advance(3000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('/white ↔ /black and hash changes keep the stream', async () => {
  const { e, streams } = await page(B + '/game/' + ID + '/white');
  streams[0].push(ev.full(ID));
  await flush(10);
  e.setUrl(B + '/game/' + ID + '/black#12');
  await e.clock.advance(3000);
  e.setUrl(B + '/' + ID + 'wxyz');
  await e.clock.advance(3000);
  assert.strictEqual(e.streamCalls().length, 1);
  assert.ok(!streams[0].closed);
});

test('rematch after game over: new id → new session (navigation watcher survives teardown)', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID, { state: { moves: 'e2e4', status: 'mate' } }));
  await flush(10);
  assert.match(e.hudText(), /Game over: mate/);
  e.setUrl(B + '/game/ijklmnop');
  await e.clock.advance(1500);
  assert.strictEqual(e.streamCalls().length, 2);
  assert.ok(e.streamCalls()[1].url.endsWith('/ijklmnop'));
});

test('same id, page turns into TV: session torn down, HUD hidden', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID));
  await flush(10);
  e.setUrl(B + '/tv');
  await e.clock.advance(1500);
  assert.ok(streams[0].closed);
  assert.ok(!e.hudVisible());
});

// ---------------------------------------------------------------- gates
test('no token: "Token needed", no request', async () => {
  const { e } = await page(B + '/game/' + ID, { load: { local: {} } });
  assert.match(e.hudText(), /Token needed/);
  assert.strictEqual(e.fetch.calls.length, 0);
});

test('storage error: "Extension storage unavailable", no request', async () => {
  const { e } = await page(B + '/game/' + ID, { load: { local: { token: TOKEN }, localOpts: { failGet: true } } });
  assert.match(e.hudText(), /storage unavailable/);
  assert.strictEqual(e.fetch.calls.length, 0);
});

for (const st of ['undecided', 'denied', 'error']) {
  test(`consent ${st}: HUD asks for game access, zero requests; click opens settings`, async () => {
    const { e } = await page(B + '/game/' + ID, { load: { consent: st } });
    assert.match(e.hudText(), /Allow game access/);
    await e.clock.advance(60000);
    assert.strictEqual(e.fetch.calls.length, 0);
    e.hud().dispatch('click');
    await flush();
    assert.ok(e.sent.some(m => m.type === 'OPEN_CONSENT'));
    assert.strictEqual(e.fetch.calls.length, 0, 'click never grants consent');
  });
}

test('consent granted later → stream starts; withdrawn → stream aborted, no reconnect', async () => {
  const { e, streams } = await page(B + '/game/' + ID, { load: { consent: 'undecided' } });
  e.consent = 'granted';
  e.toContent({ type: 'CONSENT_CHANGED' });
  await flush(20);
  assert.strictEqual(e.streamCalls().length, 1);
  streams[0].push(ev.full(ID));
  await flush(10);
  e.consent = 'denied';
  e.toContent({ type: 'CONSENT_CHANGED' });
  await flush(20);
  assert.ok(streams[0].closed);
  assert.match(e.hudText(), /Allow game access/);
  await e.clock.advance(10 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 1);
  assert.ok(e.sent.some(m => m.type === 'ENGINE_STOP'), 'own engine job stopped');
});

test('consent is re-checked before every reconnect', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID)); streams[0].end();
  await flush(10);
  e.consent = 'denied';
  await e.clock.advance(60000);
  assert.strictEqual(e.streamCalls().length, 1);
  assert.match(e.hudText(), /Allow game access/);
});

test('token removed: stream cancelled, "Token needed", late events ignored, no new request', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID));
  await flush(10);
  const before = analyzeMsgs(e).length;
  await e.local.set({ token: '' });
  await flush(20);
  assert.ok(streams[0].closed);
  assert.match(e.hudText(), /Token needed/);
  streams[0].push(ev.state('e2e4'));
  await flush(10);
  assert.strictEqual(analyzeMsgs(e).length, before);
  await e.clock.advance(10 * 60 * 1000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('TOKEN_CLEARED from the popup stops use of the token even if storage still has it', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID));
  await flush(10);
  e.toContent({ type: 'TOKEN_CLEARED' });
  await flush(20);
  assert.ok(streams[0].closed);
  assert.match(e.hudText(), /Token needed/);
  await e.clock.advance(60000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('token changed: old stream cancelled, one new stream with the new token', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  await e.local.set({ token: 'lip_TESTTOKENsecond' });
  await flush(20);
  assert.ok(streams[0].closed);
  assert.strictEqual(e.streamCalls().length, 2);
  assert.strictEqual(e.streamCalls()[1].opts.headers.Authorization, 'Bearer lip_TESTTOKENsecond');
});

test('late consent answer after navigation does not start the old session', async () => {
  let release;
  const { e } = await page(B + '/game/' + ID, {
    setup: env => { env.bgReply = msg => (msg.type === 'CONSENT_GET' && !release ? new Promise(r => { release = () => r({ state: 'granted' }); }) : undefined); },
  });
  e.setUrl(B + '/tv');
  await e.clock.advance(1500);
  release();
  await flush(20);
  assert.strictEqual(e.fetch.calls.length, 0);
});

// ---------------------------------------------------------------- game rules
test('human vs human: "Works only in games vs computer", stream closed, no analysis', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID, { black: { id: 'stockfish', name: 'Stockfish' } }));
  await flush(10);
  assert.match(e.hudText(), /vs computer/);
  assert.ok(streams[0].closed);
  assert.strictEqual(analyzeMsgs(e).length, 0);
});

test('AI game in Chess960: "Only standard chess is supported", no engine', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID, { variant: { key: 'chess960', name: 'Chess960' } }));
  await flush(10);
  assert.match(e.hudText(), /Only standard chess/);
  assert.strictEqual(analyzeMsgs(e).length, 0);
});

test('fromPosition is allowed; an illegal move list gives "Position unavailable"', async () => {
  const { e, streams } = await page(B + '/game/' + ID);
  streams[0].push(ev.full(ID, { variant: { key: 'fromPosition' }, initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', state: { moves: 'e1h1', status: 'started' } }));
  await flush(10);
  assert.match(e.hudText(), /Opponent thinking/);
  streams[0].push(ev.state('e1h1 e8e2'));
  await flush(10);
  assert.match(e.hudText(), /Position unavailable/);
});

// ---------------------------------------------------------------- engine
async function analysing() {
  const r = await page(B + '/game/' + ID);
  r.streams[0].push(ev.full(ID));
  await flush(10);
  const a = analyzeMsgs(r.e).pop();
  return Object.assign(r, { a });
}

test('engine lines: only for this session/job; HUD built with text nodes (no HTML)', async () => {
  const { e, a } = await analysing();
  e.toContent({ type: 'ENGINE_NAME', name: '<img src=x onerror=alert(1)>' });
  e.toContent({ type: 'ENGINE_LINE', session: a.session + 1, jobId: a.jobId, line: 'info depth 9 score cp 50 pv g1f3' });
  e.toContent({ type: 'ENGINE_LINE', session: a.session, jobId: a.jobId + 1, line: 'info depth 9 score cp 50 pv g1f3' });
  assert.doesNotMatch(e.hudText(), /Depth/);
  e.toContent({ type: 'ENGINE_LINE', session: a.session, jobId: a.jobId, line: 'info depth 9 multipv 1 score cp 50 pv e2e4 e7e5' });
  const t = e.hudText();
  assert.match(t, /Depth: 9/);
  assert.match(t, /<img src=x onerror=alert\(1\)>/, 'engine name shown as text');
  assert.ok(!e.hud().descendants().some(n => n.tagName === 'IMG'));
  assert.match(t, /Pawn/);
  e.toContent({ type: 'ENGINE_LINE', session: a.session, jobId: a.jobId, line: 'info depth 12 score cp 50 pv <b>x</b>' });
  assert.match(e.hudText(), /Depth: 9/, 'malformed line dropped');
});

test('watchdog: no engine output → one retry, then "Engine busy in another tab"; click analyzes here', async () => {
  const { e } = await analysing();
  await e.clock.advance(8100);
  assert.strictEqual(analyzeMsgs(e).length, 2);
  await e.clock.advance(8100);
  assert.match(e.hudText(), /Engine busy in another tab/);
  assert.strictEqual(analyzeMsgs(e).length, 2);
  e.hud().dispatch('click');
  await flush();
  assert.strictEqual(analyzeMsgs(e).length, 3);
});

test('preempted by another tab: busy HUD at once, no automatic retake (U3)', async () => {
  const { e, a } = await analysing();
  e.toContent({ type: 'ENGINE_PREEMPTED', session: a.session, jobId: a.jobId });
  assert.match(e.hudText(), /Engine busy/);
  await e.clock.advance(60000);
  assert.strictEqual(analyzeMsgs(e).length, 1);
  e.hud().dispatch('click', { isTrusted: false }); await flush();
  assert.strictEqual(analyzeMsgs(e).length, 1, 'a synthetic click cannot take the engine back');
});

test('engine failed to start: HUD + click retries with the reset flag', async () => {
  const { e, a } = await analysing();
  e.toContent({ type: 'ENGINE_ERROR', session: a.session, jobId: a.jobId });
  assert.match(e.hudText(), /Engine failed to start/);
  e.hud().dispatch('click');
  await flush();
  assert.strictEqual(analyzeMsgs(e).pop().retry, true);
});

test('pause (HINT_HIDE): HUD hidden, own job stopped, no analysis on new moves; HINT_SHOW resumes', async () => {
  const { e, streams } = await analysing();
  const r = e.toContent({ type: 'HINT_HIDE' });
  assert.strictEqual((await r).paused, true);
  assert.ok(!e.hudVisible());
  assert.ok(e.sent.some(m => m.type === 'ENGINE_STOP'));
  streams[0].push(ev.state('e2e4 e7e5'));
  await flush(10);
  assert.strictEqual(analyzeMsgs(e).length, 1);
  assert.ok(!e.hudVisible());
  assert.ok(!streams[0].closed, 'stream stays alive while paused');
  e.toContent({ type: 'HINT_SHOW' });
  await flush();
  assert.strictEqual(analyzeMsgs(e).length, 2);
  assert.ok(e.hudVisible());
});

test('pause hides status messages too (hidden context outranks consent/token texts)', async () => {
  const { e } = await page(B + '/game/' + ID, { load: { local: {} } });
  e.toContent({ type: 'HINT_HIDE' });
  await e.clock.advance(3000);
  assert.ok(!e.hudVisible());
});

// ---------------------------------------------------------------- board signal (G8)
function movePiece(board, e, transform) {
  board.replaceChildren();
  const p = e.document.createElement('piece'); p.className = 'white pawn'; p.style.transform = transform;
  board.appendChild(p);
}

test('board changed and stream silent > 5 s → one fast reconnect from the shared budget', async () => {
  const { e, streams } = await analysing();
  const board = e.document.selectors['cg-board'];
  movePiece(board, e, 'translate(0px, 64px)');
  e.fireMutations();
  await e.clock.advance(400 + 5100);
  assert.strictEqual(e.streamCalls().length, 2);
  assert.ok(streams[0].closed);
  assert.strictEqual(e.get('session.attempts'), 2);
});

test('board change answered by the stream → no reconnect; flip is not a move', async () => {
  const { e, streams } = await analysing();
  const board = e.document.selectors['cg-board'];
  movePiece(board, e, 'translate(0px, 64px)');
  e.fireMutations();
  await e.clock.advance(1000);
  streams[0].push(ev.state('e2e4'));
  await e.clock.advance(6000);
  assert.strictEqual(e.streamCalls().length, 1);
  board.parentNode.className = 'cg-wrap orientation-black';
  movePiece(board, e, 'translate(448px, 0px)');
  e.fireMutations();
  await e.clock.advance(7000);
  assert.strictEqual(e.streamCalls().length, 1);
});

test('board signal never bypasses the 429 cooldown', async () => {
  let n = 0;
  const { e } = await page(B + '/game/' + ID, { setup: env => { env.fetch.reply = () => (++n === 1 ? 429 : streamResponse(200)); } });
  const board = e.document.selectors['cg-board'];
  movePiece(board, e, 'translate(0px, 64px)');
  e.fireMutations();
  await e.clock.advance(10000);
  assert.strictEqual(e.streamCalls().length, 1);
  await e.clock.advance(51000);
  assert.strictEqual(e.streamCalls().length, 2);
});

test('board node replaced → observer follows the new node', async () => {
  const { e } = await analysing();
  const fresh = e.document.createElement('cg-board');
  e.document.selectors['cg-board'] = fresh;
  await e.clock.advance(1100);
  assert.strictEqual(e.get('session.board.el') === fresh, true);
});

// ---------------------------------------------------------------- messages
test('messages from another extension are ignored', async () => {
  const { e } = await analysing();
  e.toContent({ type: 'HINT_HIDE' }, { id: 'evil@ext' });
  assert.ok(e.hudVisible());
});

test('HUD position from sessionStorage is validated', async () => {
  const { e } = await page(B + '/game/' + ID, {
    setup: env => { env.ctx; },
    load: {},
  });
  assert.ok(e.hud());
  const h = e.hud();
  assert.ok(!/expression|url\(/.test(String(h.style.top) + String(h.style.left)));
});
