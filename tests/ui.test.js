'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { src, makeDocument, makeArea, makeEvent, flush } = require('./helpers/env');

function ui(name, reply) {
  const document = makeDocument();
  for (const m of src(name + '.html').matchAll(/id="([^"]+)"/g)) {
    const n = document.createElement('div'); n.id = m[1]; n.value = ''; n.focus = () => {};
    document.body.appendChild(n);
  }
  const browser = {
    runtime: { getManifest: () => ({ version: '1.1.1' }), getURL: p => 'moz-extension://test/' + p, sendMessage: async m => reply(m) },
    storage: { local: makeArea({ newsOptIn: true }), sync: makeArea({}), onChanged: makeEvent() },
    tabs: { query: async () => [], create: async () => ({}) },
    permissions: { getAll: async () => ({ data_collection: [] }), request: async () => true, onAdded: makeEvent(), onRemoved: makeEvent() },
    management: { uninstallSelf: async () => {} },
  };
  const ctx = vm.createContext({ browser, document, window: { close() {} }, URL, console,
    fetch: async () => new Response('', { status: 404 }), setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(src('common.js'), ctx);
  vm.runInContext(src(name + '.js'), ctx);
  const init = document._listeners.DOMContentLoaded[0]();
  return { document, browser, init, get: id => document.getElementById(id) };
}

test('modern Allow reports a failed decision write', async () => {
  const e = ui('consent', m => m.type === 'CONSENT_GET' ? { state: 'undecided' } : { ok: false });
  await e.init;
  e.get('allow').dispatch('click'); await flush(10);
  assert.match(e.get('game-msg').textContent, /storage error/);
});

test('popup displays default news without a checkbox and dismisses the item', async () => {
  const news = { id: 'test', title: 'News', body: '', url: 'https://lichess.org/@/GenMate' };
  const e = ui('popup', m => m.type === 'GET_NEWS' ? { news } : { ok: true, state: 'granted' });
  await e.init;
  assert.strictEqual(e.get('news-optin'), null);
  assert.strictEqual(e.get('news-plate').style.display, 'flex');
  await e.get('news-close').onclick({ stopPropagation() {} });
  assert.strictEqual(e.get('news-plate').style.display, 'none');
});

test('data settings disclose default-on news without offering the retired setting', async () => {
  const e = ui('consent', () => ({ ok: true, state: 'granted' }));
  await e.init;
  assert.strictEqual(e.get('news'), null);
  assert.match(src('consent.html'), /by default/);
});

test('popup respects refusal while keeping data settings available', async () => {
  for (const state of ['granted', 'denied', 'undecided', 'error']) {
    const e = ui('popup', () => ({ state })); await e.init;
    assert.strictEqual(e.get('consent-needed').style.display, ['granted', 'denied'].includes(state) ? 'none' : '', state);
    assert.ok(e.get('data-settings')._listeners.click.length);
  }
});

test('popup rejects header-unsafe tokens without writing or echoing them', async () => {
  const e = ui('popup', () => ({ state: 'granted' })); await e.init;
  for (const token of ['bad token', 'bad\ntoken', 'bad\u0000token', 'bad\u007ftoken', 'bad\u0100token']) {
    e.get('token-input').value = token;
    await e.get('token-save').onclick();
    assert.strictEqual(e.browser.storage.local.data.token, undefined);
    assert.match(e.get('popup-status').textContent, /Token not saved/);
    assert.ok(!e.get('popup-status').textContent.includes(token));
  }
  e.get('token-input').value = '  lip_TESTTOKEN0000000000  ';
  await e.get('token-save').onclick();
  assert.strictEqual(e.browser.storage.local.data.token, 'lip_TESTTOKEN0000000000');
  assert.strictEqual(e.get('token-input').value, '');
});

test('popup offers three lines and defaults From-square on', async () => {
  const e = ui('popup', () => ({ state: 'granted' })); await e.init;
  assert.match(src('popup.html'), /<option value="3">3<\/option>/);
  assert.strictEqual(e.get('show-from').checked, true);
  e.get('pv-select').value = '3'; e.get('pv-select').dispatch('change'); await flush();
  assert.strictEqual(e.browser.storage.local.data.multiPv, 3);
});
