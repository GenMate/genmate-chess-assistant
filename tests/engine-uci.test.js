// G11 / G20 — UCI protocol on the real bundled Stockfish wasm, run in Node
// through the engine's own Node entry point. No fixed best move: the output
// format is checked with the surface parser and legality with chess.js.
// Commands are sent one at a time from the test (never from inside the
// engine's output callback), like the worker's message queue does.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EXT, loadSurface } = require('./helpers/env');

const S = loadSurface();
function chess() {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'chess.js'), 'utf8'), ctx);
  return vm.runInContext('Chess', ctx);
}
function legal(fen, uci) {
  const C = chess(); const c = new C(fen);
  return !!c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
}

for (const flavor of ['lite', 'full']) {
const wrapper = fs.readFileSync(path.join(EXT, 'wasm', 'sf-' + flavor + '-worker.js'), 'utf8');
const jsName = (wrapper.match(/importScripts\(sfBase \+ '([^']+\.js)'\)/) || [])[1];
const wasmName = (wrapper.match(/url = sfBase \+ '([^']+\.wasm)'/) || [])[1];
const JS = jsName && path.join(EXT, 'wasm', jsName);
const WASM = wasmName && path.join(EXT, 'wasm', wasmName);

test(flavor + ' worker wrapper points at matching JS/WASM files', () => {
  assert.ok(JS && WASM, 'names found in sf-lite-worker.js');
  assert.ok(fs.existsSync(JS), jsName);
  assert.ok(fs.existsSync(WASM), wasmName);
  assert.strictEqual(jsName.replace(/\.js$/, ''), wasmName.replace(/\.wasm$/, ''));
  const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.ok(bg.includes("'wasm/" + jsName + "'") && bg.includes("'wasm/" + wasmName + "'"), 'enginePresent checks both files');
});

async function startEngine() {
  const out = [];
  const listener = l => { for (const x of String(l).split(/\r?\n/)) if (x.trim()) out.push(x.trim()); };
  let m = require(JS);
  if (typeof m === 'function') m = m();
  if (typeof m === 'function') m = await m({ listener, locateFile: () => WASM });   // emscripten factory (18.x)
  else { m.listener = listener; }                                                   // module object (19.x)
  const cmd = c => (typeof m.processCommand === 'function' ? m.processCommand(c) : m.ccall('command', null, ['string'], [c]));
  const wait = async (re, from, ms = 20000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const hit = out.slice(from).find(l => re.test(l));
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timeout waiting for ' + re + '; last: ' + out.slice(-3).join(' | '));
  };
  return { out, cmd, wait, stop: () => { try { m.terminate && m.terminate(); } catch (_) {} } };
}

test(flavor + ' real engine: uci / isready / MultiPV 3 / go / stop', { timeout: 90000 }, async () => {
  const e = await startEngine();
  try {
    await new Promise(r => setTimeout(r, 300));
    let at = e.out.length; e.cmd('uci');
    await e.wait(/^uciok$/, at);
    const idName = e.out.find(l => l.startsWith('id name '));
    assert.match(idName, /^id name Stockfish \d+/);
    at = e.out.length; e.cmd('isready');
    await e.wait(/^readyok$/, at);

    // MultiPV 3, fixed depth: info lines must parse; bestmove must be legal.
    const fen1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    e.cmd('setoption name MultiPV value 3');
    e.cmd('position fen ' + fen1);
    at = e.out.length; e.cmd('go depth 8');
    const bm1 = await e.wait(/^bestmove /, at);
    const infos = e.out.slice(at).filter(l => l.startsWith('info ') && / pv /.test(l));
    const parsed = infos.map(l => S.parseEngineInfo(l));
    assert.ok(parsed.length > 0 && parsed.every(Boolean), 'every pv line passes the strict parser');
    assert.ok(parsed.some(p => p.multipv === 3), 'MultiPV 3 lines present');
    for (const p of parsed) assert.ok(legal(fen1, p.move), 'pv move legal: ' + p.move);
    const move1 = bm1.split(/\s+/)[1];
    assert.ok(S.UCI_MOVE_RE.test(move1) && legal(fen1, move1), 'bestmove legal: ' + move1);

    // Infinite search answers "stop" quickly with a legal bestmove.
    const fen2 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    e.cmd('setoption name MultiPV value 1');
    e.cmd('ucinewgame');
    e.cmd('position fen ' + fen2);
    at = e.out.length; e.cmd('go infinite');
    await new Promise(r => setTimeout(r, 1000));
    const tStop = Date.now();
    e.cmd('stop');
    const bm2 = await e.wait(/^bestmove /, at, 5000);
    assert.ok(Date.now() - tStop < 2000, 'bestmove within the 2 s stop barrier');
    assert.ok(legal(fen2, bm2.split(/\s+/)[1]));

    // Timed search.
    at = e.out.length; e.cmd('position startpos'); e.cmd('go movetime 300');
    const bm3 = await e.wait(/^bestmove /, at, 5000);
    assert.ok(legal('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', bm3.split(/\s+/)[1]));
  } finally { e.stop(); }
});

}
