// G1 — game URL parsing (TZ 5.1 examples plus hardening cases).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadSurface } = require('./helpers/env');

const S = loadSurface();
const B = 'https://lichess.org';

const OK = [
  '/game/i40iA4IQ', '/game/i40iA4IQ/black#12', '/game/i40iA4IQabcd?x=1', '/i40iA4IQ', '/i40iA4IQ/white',
  '/game/i40iA4IQ/', '/i40iA4IQabcd', '/game/i40iA4IQ/white/', '/i40iA4IQ#5', '/i40iA4IQ?pov=black',
];
const NULL = [
  '/tournament', '/streamer', '/timeline', '/analysis', '/training', '/game/export/i40iA4IQ',
  '/game/i40iA4IQ/black/analysis', '/study/abcdefgh', '/@/GenMate', '/game/abc1234',
  '/', '/game', '/game/', '/games', '/game/i40iA4IQ/mini', '/game/i40iA4IQabcd/forecasts',
  '/practice', '/password', '/bookmark', '/features', '/insights', '/markdown', '/InstantChess',
  '/i40iA4IQ/black/analysis', '/embed/game/i40iA4IQ', '/api/board/game/stream/i40iA4IQ',
  '/game/i40iA4IQa', '/i40iA4IQ_x', '/game/i40iA4I%51',
];

for (const p of OK) test('game id from ' + p, () => assert.strictEqual(S.parseGameUrl(B + p), 'i40iA4IQ'));
for (const p of NULL) test('no game id for ' + p, () => assert.strictEqual(S.parseGameUrl(B + p), null));

test('/game/<id> is a game even when <id> equals a reserved root', () => {
  assert.strictEqual(S.parseGameUrl(B + '/game/analysis'), 'analysis');
  assert.strictEqual(S.parseGameUrl(B + '/game/training'), 'training');
  assert.strictEqual(S.parseGameUrl(B + '/analysis'), null);
});

test('12-char id is cut to the 8-char game id', () => {
  assert.strictEqual(S.parseGameUrl(B + '/game/AbCd1234WxYz'), 'AbCd1234');
  assert.strictEqual(S.parseGameUrl(B + '/AbCd1234WxYz/black'), 'AbCd1234');
});

test('only https://lichess.org without credentials or custom port', () => {
  for (const u of [
    'http://lichess.org/game/i40iA4IQ',
    'https://lichess.dev/game/i40iA4IQ',
    'https://www.lichess.org/game/i40iA4IQ',
    'https://lichess.org.evil.example/game/i40iA4IQ',
    'https://user:pw@lichess.org/game/i40iA4IQ',
    'https://user@lichess.org/game/i40iA4IQ',
    'https://lichess.org:8443/game/i40iA4IQ',
    'not a url', '', null, undefined, 42,
  ]) assert.strictEqual(S.parseGameUrl(u), null, String(u));
  assert.strictEqual(S.parseGameUrl('https://lichess.org:443/game/i40iA4IQ'), 'i40iA4IQ'); // default port normalises away
});

test('1.1.0 regex missed /game/<id> (regression reason)', () => {
  const old = u => { const m = u.match(/lichess\.org\/([a-zA-Z0-9]{8,12})(\/|$|#|\?)/); return m ? m[1].slice(0, 8) : null; };
  assert.strictEqual(old(B + '/game/i40iA4IQ'), null);
  assert.strictEqual(S.parseGameUrl(B + '/game/i40iA4IQ'), 'i40iA4IQ');
});

test('streamUrl only accepts an 8-char id', () => {
  assert.strictEqual(S.streamUrl('i40iA4IQ'), 'https://lichess.org/api/board/game/stream/i40iA4IQ');
  assert.throws(() => S.streamUrl('../x'));
  assert.throws(() => S.streamUrl('i40iA4IQabcd'));
});
