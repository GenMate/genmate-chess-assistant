// Chess Assistant by GenMate — full NNUE worker
// SPDX-License-Identifier: GPL-3.0-or-later
// Same loader pattern as sf-lite-worker.js, pointed at the full single build.
self.IS_ASYNCIFY = true;
const sfBase = self.location.href.replace(/[^/]+$/, '');
const _origFetch = self.fetch.bind(self);
self.fetch = (url, opts) => {
  if (typeof url === 'string' && /\.wasm$/.test(url) && !url.includes('.wasm.map'))
    url = sfBase + 'stockfish-18-single.wasm';
  return _origFetch(url, opts);
};
importScripts(sfBase + 'stockfish-18-single.js');
