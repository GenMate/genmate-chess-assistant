// Regression adapted from the final audit's waiting-tab reproduction.
// Route actual background/content messages; never inject CONSENT_CHANGED.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, loadContent, streamResponse, flush, ev } = require('./helpers/env');

async function decision(b, granted) {
  if (b.perms.modern) {
    b.perms.granted = granted;
    (granted ? b.permAdded : b.permRemoved).fns.forEach(f => f({ data_collection: ['authenticationInfo', 'browsingActivity'] }));
  }
  await b.send({ type: 'CONSENT_SET', game: granted }, b.pageSender('consent.html'));
  await flush(20);
}

for (const modern of [true, false]) {
  test(`waiting tab receives grant without engine registration (modern=${modern})`, async () => {
    const b = loadBackground({ modern, granted: false });
    await flush(10);
    assert.equal((await b.send({ type: 'CONSENT_GET' }, b.contentSender(7))).state, 'undecided');
    await decision(b, true);
    assert.ok(b.linesTo(7).some(m => m.type === 'CONSENT_CHANGED'));
  });

  test(`background → waiting HUD → grant → analysis → revoke → regrant (modern=${modern})`, async () => {
    const b = loadBackground({ modern });
    await flush(10);
    const streams = [];
    const e = loadContent({ url: 'https://lichess.org/game/abcdefgh', local: { token: 'lip_TESTTOKEN0000000000' },
      setup: env => {
        env.gamePage({});
        env.bgReply = msg => b.send(msg, b.contentSender(7));
        env.fetch.reply = () => { const s = streamResponse(); streams.push(s); return s; };
      } });
    const record = b.browser.tabs.sendMessage;
    b.browser.tabs.sendMessage = async (id, msg) => { await record(id, msg); if (id === 7) return e.toContent(msg); };
    await flush(20);
    assert.match(e.hudText(), /Allow game access/);
    assert.equal(streams.length, 0);
    assert.equal(e.sent.some(m => m.type === 'ENGINE_REGISTER'), false);
    await decision(b, true);
    assert.equal(streams.length, 1, 'modern permission + storage events must not duplicate the stream');
    streams[0].push(ev.full('abcdefgh')); await flush(20);
    assert.ok(e.sent.some(m => m.type === 'ENGINE_ANALYZE'));
    b.worker().emit('info depth 12 multipv 1 score cp 20 pv e2e4 e7e5'); await flush(10);
    assert.match(e.hudText(), /Depth: 12/, 'the real message route delivers the hint to the HUD');
    const old = e.streamCalls()[0];
    await decision(b, false);
    assert.equal(old.opts.signal.aborted, true);
    assert.match(e.hudText(), /Allow game access/);
    await e.clock.advance(30000);
    assert.equal(streams.length, 1, 'no stream after revocation');
    await decision(b, true);
    assert.equal(streams.length, 2, 'resume on the same page without reload');
  });
}

test('waiting subscription survives engine port disconnect and preemption', async () => {
  const b = loadBackground({ granted: true }); await flush(10);
  await b.send({ type: 'CONSENT_GET' }, b.contentSender(7));
  const port = b.connectTab(7);
  const job = { type: 'ENGINE_ANALYZE', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', session: 1, jobId: 1, infinite: true, multiPv: 1, movetime: 3000 };
  await b.send(job, b.contentSender(7));
  await b.send(job, b.contentSender(8));
  assert.ok(b.linesTo(7).some(m => m.type === 'ENGINE_PREEMPTED'));
  port.disconnect(); await flush(10);
  assert.equal(b.get('current.owner.tabId'), 8, 'disconnect cannot stop the new owner');
  await decision(b, false);
  assert.ok(b.linesTo(7).some(m => m.type === 'CONSENT_CHANGED'));
  assert.equal(b.get('current'), null);
});

test('closed waiting tab is removed; failed delivery is pruned; extension pages do not subscribe', async () => {
  const b = loadBackground({ modern: false }); await flush(10);
  await b.send({ type: 'CONSENT_GET' }, b.pageSender('consent.html'));
  await b.send({ type: 'CONSENT_GET' }, { id: 'untrusted', tab: { id: 9, url: 'https://lichess.org/' } });
  await b.send({ type: 'CONSENT_GET' }, b.contentSender(7));
  await b.send({ type: 'CONSENT_GET' }, b.contentSender(8));
  b.tabRemoved.fns.forEach(f => f(7));
  const deliveries = [];
  b.browser.tabs.sendMessage = async id => { deliveries.push(id); throw new Error('no receiver'); };
  await decision(b, true);
  assert.deepEqual(deliveries, [8]);
  deliveries.length = 0;
  await decision(b, false);
  assert.deepEqual(deliveries, []);
});

test('closing a subscribed owner stops only its search and removes its port', async () => {
  const b = loadBackground({ granted: true }); await flush(10);
  await b.send({ type: 'CONSENT_GET' }, b.contentSender(7)); b.connectTab(7);
  await b.send({ type: 'ENGINE_ANALYZE', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', session: 1, jobId: 1, infinite: true, multiPv: 1, movetime: 3000 }, b.contentSender(7));
  b.tabRemoved.fns.forEach(f => f(7)); await flush(10);
  assert.equal(b.get('current'), null);
  assert.equal(b.get('tabPorts.size'), 0);
  b.toTabs.length = 0;
  await decision(b, false);
  assert.equal(b.linesTo(7).length, 0);
});

test('closing a tab during a slow consent lookup cannot recreate its subscription', async () => {
  const b = loadBackground({ modern: false }); await flush(10);
  const originalGet = b.local.get;
  let release;
  b.local.get = () => new Promise(resolve => { release = resolve; });
  const pending = b.send({ type: 'CONSENT_GET' }, b.contentSender(7));
  await flush(10);
  assert.ok(release);
  b.tabRemoved.fns.forEach(f => f(7));
  release({}); await pending;
  b.local.get = originalGet;
  await decision(b, true);
  assert.equal(b.linesTo(7).length, 0);
});
