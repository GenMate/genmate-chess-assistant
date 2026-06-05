// Chess Assistant by GenMate — Lite v1
// SPDX-License-Identifier: GPL-3.0-or-later
self.IS_ASYNCIFY = true;
const sfBase = self.location.href.replace(/[^/]+$/, '');
const _origFetch = self.fetch.bind(self);
self.fetch = (url, opts) => {
  if (typeof url === 'string' && /\.wasm$/.test(url) && !url.includes('.wasm.map'))
    url = sfBase + 'stockfish-18-lite-single.wasm';
  return _origFetch(url, opts);
};
importScripts(sfBase + 'stockfish-18-lite-single.js');
