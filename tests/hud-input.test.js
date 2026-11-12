'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContent, flush } = require('./helpers/env');

test('synthetic HUD clicks cannot open consent; trusted clicks still work', async () => {
  const e = loadContent({ url: 'https://lichess.org/game/abcdefgh', consent: 'undecided', setup: e => e.gamePage({}) });
  await flush(20);
  e.hud().dispatch('click', { isTrusted: false }); await flush();
  assert.equal(e.sent.filter(m => m.type === 'OPEN_CONSENT').length, 0);
  e.hud().dispatch('click', { isTrusted: true }); await flush();
  assert.equal(e.sent.filter(m => m.type === 'OPEN_CONSENT').length, 1);
});

test('synthetic HUD clicks cannot restart a failed stream', async () => {
  const e = loadContent({ url: 'https://lichess.org/game/abcdefgh', local: { token: 'lip_TESTTOKEN0000000000' },
    setup: e => { e.gamePage({}); e.fetch.reply = () => 500; } });
  await flush(20);
  await e.clock.advance(600000);
  assert.match(e.hudText(), /Connection lost/);
  e.hud().dispatch('click', { isTrusted: false }); await flush();
  assert.equal(e.streamCalls().length, 12);
  e.hud().dispatch('click', { isTrusted: true }); await flush(20);
  assert.equal(e.streamCalls().length, 13);
});

test('header-unsafe legacy tokens show token error without network retries', async () => {
  for (const token of ['bad\ntoken', 'bad\u0100token', 'bad token']) {
    const e = loadContent({ url: 'https://lichess.org/game/abcdefgh', sync: { token }, setup: e => e.gamePage({}) });
    await flush(20);
    await e.clock.advance(60000);
    assert.equal(e.streamCalls().length, 0);
    assert.match(e.hudText(), /Token invalid/);
    assert.ok(!e.hudText().includes(token));
  }
});
