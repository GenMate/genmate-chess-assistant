// G9 / U5 / W2 — news channel: strict validation, host allowlist, size
// limit, default-on checks, notification once per id, legacy setting migration.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCommon, loadBackground, streamResponse, flush, J } = require('./helpers/env');

const C = loadCommon();
const GOOD = { id: '2026-10-v1-1-1', title: 'Chess Assistant 1.1.1 is available', body: 'Lichess moved game pages to /game/<id>.', url: 'https://lichess.org/@/GenMate' };

test('notification service rejection is handled without an unhandled promise', async () => {
  const b = loadBackground({ newsReply: newsReply(JSON.stringify(GOOD)) });
  b.get('browser.notifications.create = async () => { throw new Error("service unavailable"); }');
  await flush(30);
  assert.strictEqual(b.notifications.length, 0);
  assert.strictEqual((await b.send({ type: 'GET_NEWS' }, b.pageSender('popup.html'))).news.id, GOOD.id);
});

test('obsolete opt-in values cannot disable the default-on channel', async () => {
  for (const newsOptIn of [false, true, undefined]) {
    const b = loadBackground({ local: { newsOptIn }, newsReply: newsReply(JSON.stringify(GOOD)) });
    await flush(30);
    assert.strictEqual(b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com')).length, 1);
    assert.strictEqual(b.notifications.length, 1);
    assert.strictEqual((await b.send({ type: 'GET_NEWS' }, b.pageSender('popup.html'))).news.id, GOOD.id);
  }
});

test('validateNews accepts the planned 1.1.1 announcement', () => {
  assert.deepStrictEqual(J(C.validateNews(GOOD)), GOOD);
  assert.deepStrictEqual(J(C.validateNews({ id: 'a', title: 't', body: '' })), { id: 'a', title: 't', body: '', url: null });
});

test('validateNews rejects wrong types, lengths and extra keys', () => {
  const bad = [
    null, 'x', [], {}, Object.assign({}, GOOD, { id: 5 }), Object.assign({}, GOOD, { id: 'bad id' }),
    Object.assign({}, GOOD, { id: 'x'.repeat(65) }), Object.assign({}, GOOD, { title: 't'.repeat(81) }),
    Object.assign({}, GOOD, { title: '' }), Object.assign({}, GOOD, { body: 'b'.repeat(201) }),
    Object.assign({}, GOOD, { body: { html: '<b>' } }), Object.assign({}, GOOD, { url: 5 }),
    Object.assign({}, GOOD, { html: '<img src=x onerror=alert(1)>' }),
  ];
  for (const n of bad) assert.strictEqual(C.validateNews(n), null, JSON.stringify(n));
});

test('url allowlist: https + exact host, no credentials/port; otherwise link dropped', () => {
  for (const u of ['https://lichess.org/@/GenMate', 'https://github.com/GenMate/genmate-chess-assistant', 'https://addons.mozilla.org/firefox/'])
    assert.ok(C.safeNewsUrl(u), u);
  for (const u of [
    'http://lichess.org/', 'https://lichess.org.evil.com/', 'https://evil.com/lichess.org', 'https://xn--lichss-9ua.org/',
    'https://www.lichess.org/', 'https://gist.github.com/', 'https://user:pw@lichess.org/', 'https://lichess.org:8443/',
    'javascript:alert(1)', 'data:text/html,x', 'https://lichess.org/' + 'a'.repeat(2048), '', null,
  ]) assert.strictEqual(C.safeNewsUrl(u), null, String(u).slice(0, 60));
  const n = C.validateNews(Object.assign({}, GOOD, { url: 'https://lichess.org.evil.com/x' }));
  assert.ok(n && n.url === null && n.title === GOOD.title, 'text kept, link dropped');
});

function newsReply(body, chunks) {
  return () => {
    const s = streamResponse(200);
    setImmediate(() => { for (const c of (chunks || [body])) s.push(c); s.end(); });
    return s;
  };
}

test('news is on by default on startup and checks periodically without duplicate notification', async () => {
  const b = loadBackground({ newsReply: newsReply(JSON.stringify(GOOD)) });
  await flush(20);
  b.onInstalled.fns.forEach(f => f({ reason: 'update' }));
  await flush(20);
  await b.clock.advance(7 * 60 * 60 * 1000);
  assert.strictEqual(b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com')).length, 2);
  assert.strictEqual(b.notifications.length, 1);
});

test('default news: one notification per id, cookies omitted, no-store, popup plate until dismissed', async () => {
  const b = loadBackground({ local: { newsOptIn: true }, newsReply: newsReply(JSON.stringify(GOOD)) });
  await flush(30);
  const calls = b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com'));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.credentials, 'omit');
  assert.strictEqual(calls[0].opts.cache, 'no-store');
  assert.ok(!/token|Authorization/i.test(JSON.stringify(calls[0].opts)));
  assert.strictEqual(b.notifications.length, 1);
  await b.clock.advance(6 * 60 * 60 * 1000 + 10);
  await flush(30);
  assert.strictEqual(b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com')).length, 2);
  assert.strictEqual(b.notifications.length, 1, 'same id → no second notification');
  const popup = b.pageSender('popup.html');
  assert.strictEqual((await b.send({ type: 'GET_NEWS' }, popup)).news.id, GOOD.id);
  assert.deepStrictEqual(J(await b.send({ type: 'DISMISS_NEWS', id: 'other' }, popup)), { ok: false });
  assert.deepStrictEqual(J(await b.send({ type: 'DISMISS_NEWS', id: GOOD.id }, popup)), { ok: true });
  assert.strictEqual((await b.send({ type: 'GET_NEWS' }, popup)).news, null);
});

test('oversized response (chunked) is dropped', async () => {
  const big = JSON.stringify(Object.assign({}, GOOD, { pad: 'x'.repeat(20000) }));
  const chunks = []; for (let i = 0; i < big.length; i += 1000) chunks.push(big.slice(i, i + 1000));
  const b = loadBackground({ local: { newsOptIn: true }, newsReply: newsReply(null, chunks) });
  await flush(60);
  assert.strictEqual(b.notifications.length, 0);
  assert.ok(!('pendingNews' in b.local.data));
});

test('news with a lookalike host: text shown, link not opened', async () => {
  const b = loadBackground({ local: { newsOptIn: true }, newsReply: newsReply(JSON.stringify(Object.assign({}, GOOD, { url: 'https://lichess.org.evil.com/' }))) });
  await flush(30);
  assert.strictEqual(b.notifications.length, 1);
  b.notifOnClicked.fns.forEach(f => f('gm'));
  await flush(10);
  assert.strictEqual(b.created.length, 0);
});

test('old 1.1.0 pendingNews with a bad link is re-validated in both sinks', async () => {
  const old = { id: 'old-1', title: 'Old', body: 'x', url: 'http://phish.example/' };
  const b = loadBackground({ local: { newsOptIn: true, pendingNews: old } });
  await flush(20);
  b.notifOnClicked.fns.forEach(f => f('gm'));
  await flush(10);
  assert.strictEqual(b.created.length, 0);
  const r = await b.send({ type: 'GET_NEWS' }, b.pageSender('popup.html'));
  assert.strictEqual(r.news.url, null);
  const evil = { id: 'old-2', title: 'Old', body: 'x', url: 'https://lichess.org/', extra: '<script>' };
  const b2 = loadBackground({ local: { newsOptIn: true, pendingNews: evil } });
  await flush(20);
  assert.strictEqual((await b2.send({ type: 'GET_NEWS' }, b2.pageSender('popup.html'))).news, null);
});

test('valid link opens once on notification click', async () => {
  const b = loadBackground({ local: { newsOptIn: true }, newsReply: newsReply(JSON.stringify(GOOD)) });
  await flush(30);
  b.notifOnClicked.fns.forEach(f => f('gm'));
  await flush(10);
  assert.deepStrictEqual(J(b.created), [{ url: 'https://lichess.org/@/GenMate' }]);
});

test('retired NEWS_SET cannot change behavior or persist a new setting', async () => {
  const b = loadBackground({ newsReply: newsReply(JSON.stringify(GOOD)) });
  await flush(30);
  for (const sender of [b.contentSender(3), b.pageSender('popup.html'), b.pageSender('consent.html')]) {
    assert.strictEqual(await b.send({ type: 'NEWS_SET', enabled: false }, sender), undefined);
  }
  assert.ok(!('newsOptIn' in b.local.data));
  assert.strictEqual((await b.send({ type: 'GET_NEWS' }, b.pageSender('popup.html'))).news.id, GOOD.id);
});

test('concurrent checks are serialised', async () => {
  const b = loadBackground({ local: { newsOptIn: true }, newsReply: () => streamResponse(200) });
  await flush(10);
  b.get('checkNews(); checkNews(); checkNews();');
  await flush(10);
  assert.strictEqual(b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com')).length, 1);
});

test('storage failure is handled without blocking default news or analysis', async () => {
  const b = loadBackground({ localOpts: { failGet: true }, newsReply: newsReply(JSON.stringify(GOOD)) });
  await flush(30);
  assert.strictEqual(b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com')).length, 1);
  assert.strictEqual(b.notifications.length, 0);
  assert.strictEqual((await b.send({ type: 'GET_NEWS' }, b.pageSender('popup.html'))).news, null);
});

test('news remains independent of game-access consent', async () => {
  const b = loadBackground({ newsReply: newsReply(JSON.stringify(GOOD)) });
  await b.send({ type: 'CONSENT_SET', game: false }, b.pageSender('consent.html'));
  await flush(30);
  assert.strictEqual(b.fetch.calls.filter(c => c.url.includes('raw.githubusercontent.com')).length, 1);
  assert.strictEqual(b.notifications.length, 1);
});
