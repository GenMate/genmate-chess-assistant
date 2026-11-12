// G6/G15 — chess.js 0.10.3 (official file) and the all-or-nothing replay.
// Part 1: behavioural equivalence of the old bundled chess.min.js (1.1.0,
// read from ref/1.1.0-pristine if present) and the new chess.js on the API
// that content.js uses. Part 2: replayPosition from the integration surface.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { EXT, loadSurface, J } = require('./helpers/env');

const NEW = path.join(EXT, 'chess.js');
const OLD = path.join(__dirname, '..', 'ref', '1.1.0-pristine', 'chess.min.js');
const INIT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('replay rejects missing initial FEN and positions without exactly one king per side', () => {
  const s = loadSurface();
  for (const fen of ['', null, undefined, '8/8/8/8/8/8/8/8 w - - 0 1', '4k3/8/8/8/8/8/8/4KK2 w - - 0 1']) {
    assert.strictEqual(s.replayPosition(fen, ''), null);
  }
});

function load(p) {
  const ctx = { module: { exports: {} }, exports: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(p, 'utf8'), ctx);
  return vm.runInContext('typeof Chess!=="undefined"?Chess:(module.exports.Chess||module.exports)', ctx);
}

test('chess.js is the official 0.10.3 file (sha256 = npm = git tag v0.10.3)', () => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(NEW)).digest('hex');
  assert.strictEqual(h, '1a6803b787dc4a6f71aabdd0b010cee7bf0fc70ce032f5ed8d7738684d431bfc');
});

const haveOld = fs.existsSync(OLD);
function replay(C, fen, moves) {
  const c = new C(fen === 'startpos' ? INIT : fen); const out = [];
  for (let u of moves.split(/\s+/).filter(Boolean)) {
    const fp = c.get(u.slice(0, 2));
    if (fp && fp.type === 'k') { if (u === 'e1h1') u = 'e1g1'; else if (u === 'e1a1') u = 'e1c1'; else if (u === 'e8h8') u = 'e8g8'; else if (u === 'e8a8') u = 'e8c8'; }
    const r = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
    out.push(r ? r.san : null);
  }
  return { sans: out, fen: c.fen() };
}
const CASES = [
  ['startpos', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1h1 f8c5 d2d3 e8h8'],
  ['startpos', 'd2d4 d7d5 c1f4 c7c5 e2e3 b8c6 c2c3 d8b6 d1b3 c5c4 b3c2 e8a8'],
  ['startpos', 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 c7c6 g1f3 c8g4 f1e2 e7e6 e1h1 b8d7 c1e3 g8f6 h2h3 g4h5 a2a3 f8e7 b2b4 a5c7 d1d2 e8h8'],
  ['startpos', 'a2a4 b7b5 a4b5 c7c5 b5c6 a7a5 c6d7 e8d7'],
  ['startpos', 'h2h4 g7g5 h4g5 h7h6 g5h6 g8f6 h6g7 f6g8 g7h8q'],
  ['startpos', 'h2h4 g7g5 h4g5 h7h6 g5h6 g8f6 h6g7 f6g8 g7h8n'],
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1', 'e7e5 e2e4'],
  ['8/8/8/8/8/8/8/8 w - - 0 1', 'e2e4'],
  ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1a1 e8h8'],
  ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 'e5d6'],
  ['startpos', 'e2e4 e2e4'],
];
for (const [fen, mv] of CASES) {
  test(`equivalence old/new: ${fen.slice(0, 16)} | ${mv.slice(0, 32)}`, { skip: !haveOld && 'ref/1.1.0-pristine not present' }, () => {
    assert.deepStrictEqual(J(replay(load(OLD), fen, mv)), J(replay(load(NEW), fen, mv)));
  });
}
for (const f of ['not a fen', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNQ w KQkq - 0 1', '', 'startpos']) {
  test(`equivalence old/new on bad FEN "${f.slice(0, 20)}"`, { skip: !haveOld && 'ref/1.1.0-pristine not present' }, () => {
    const run = C => { try { const c = new C(f); return ['ok', c.fen()]; } catch (e) { return ['throw', e.message]; } };
    assert.deepStrictEqual(J(run(load(OLD))), J(run(load(NEW))));
  });
}
test('equivalence old/new: get() on all squares and checkmate', { skip: !haveOld && 'ref/1.1.0-pristine not present' }, () => {
  const A = load(OLD), Bc = load(NEW);
  const sq = []; for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) sq.push(f + r);
  const a = new A(INIT), b = new Bc(INIT);
  for (const u of ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7']) { a.move({ from: u.slice(0, 2), to: u.slice(2) }); b.move({ from: u.slice(0, 2), to: u.slice(2) }); }
  assert.deepStrictEqual(J(sq.map(s => a.get(s))), J(sq.map(s => b.get(s))));
  assert.strictEqual(b.in_checkmate(), true);
});

// ---- replayPosition (G6) ----
const S = loadSurface();
const R = (fen, moves) => S.replayPosition(fen, moves);

test('replay from start position', () => {
  assert.strictEqual(R('startpos', ''), INIT);
  assert.strictEqual(R('startpos', 'e2e4 e7e5'), 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
});

test('castling in both notations, both sides, short and long', () => {
  const pre = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  const shortW = R(pre, 'e1g1'), shortW2 = R(pre, 'e1h1');
  assert.ok(shortW && shortW === shortW2 && shortW.startsWith('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1 b kq'));
  const longW = R(pre, 'e1c1'), longW2 = R(pre, 'e1a1');
  assert.ok(longW && longW === longW2 && longW.startsWith('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/2KR3R b kq'));
  const shortB = R(pre, 'e1g1 e8g8'), shortB2 = R(pre, 'e1h1 e8h8');
  assert.ok(shortB && shortB === shortB2 && shortB.startsWith('r4rk1/'));
  const longB = R(pre, 'e1c1 e8c8'), longB2 = R(pre, 'e1a1 e8a8');
  assert.ok(longB && longB === longB2 && longB.startsWith('2kr3r/'));
});

test('a rook move e8h8 is not rewritten as castling', () => {
  const fen = '4r3/6k1/8/8/8/8/8/4K3 b - - 0 1';
  assert.strictEqual(R(fen, 'e8h8'), '7r/6k1/8/8/8/8/8/4K3 w - - 1 2');
});

test('promotion with and without capture; underpromotion', () => {
  assert.strictEqual(R('6n1/7P/8/8/8/8/8/k6K w - - 0 1', 'h7g8q'), '6Q1/8/8/8/8/8/8/k6K b - - 0 1');
  assert.strictEqual(R('6n1/7P/8/8/8/8/8/k6K w - - 0 1', 'h7h8n'), '6nN/8/8/8/8/8/8/k6K b - - 0 1');
  assert.ok(R('8/P7/8/8/8/8/8/k6K w - - 0 1', 'a7a8r').startsWith('R7/'));
});

test('en passant', () => {
  assert.strictEqual(R('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 'e5d6'), '4k3/8/3P4/8/8/8/8/4K3 b - - 0 2');
  assert.ok(R('startpos', 'a2a4 b7b5 a4b5 c7c5 b5c6'));
});

test('all or nothing: an illegal or malformed move gives null, not a partial position', () => {
  assert.strictEqual(R('startpos', 'e2e4 e2e4'), null);
  assert.strictEqual(R('startpos', 'e2e4 e7e5 e1g1'), null);           // castling through pieces
  assert.strictEqual(R('startpos', 'e2e4 zz99'), null);
  assert.strictEqual(R('startpos', 'e2e4 e7e5x'), null);
  assert.strictEqual(R('8/8/8/8/8/8/8/8 w - - 0 1', 'e2e4'), null);   // no kings: invalid FEN
});

test('invalid initial FEN gives null', () => {
  for (const f of ['not a fen', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', 'rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'])
    assert.strictEqual(R(f, ''), null, f);
  assert.strictEqual(R('startpos', null), null);
});
