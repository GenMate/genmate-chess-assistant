// GenMate Chess Assistant — Lite v1
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later

// ═══════════════════════════════════════════════════════════════════
//  CONFIG — edit these to customise the hint box without diving deep
// ═══════════════════════════════════════════════════════════════════

// Font sizes (px)
const HDR_FONT  = 15;   // engine name + depth label
const BODY_FONT = 17;   // move hint (piece + evaluation)

// ── Evaluation thresholds (centipawns) ───────────────────────────
// POV is always from the token-holder's perspective:
//   positive = player has advantage, negative = player is worse
// Convention: + means White better, − means Black better (standard chess)
// We flip the sign for Black so that:
//   playing as Black, a -3.96 engine score means YOU are ahead → pov = +396
const EVAL_GOOD_THRESHOLD = 62;  // pov > +62 cp  → player is clearly better → green
const EVAL_BAD_THRESHOLD  = 62;  // pov < −62 cp  → player is clearly worse  → red
                                  // between −62 and +62 cp → roughly equal   → neutral

// ── Brand name shown in the hint header ──────────────────────────
const BRAND_NAME = 'GenMate Chess Assistant';   // full name (English)

// ── Status-message typography (token needed / no game / game over) ─
// Hierarchy: the brand name is the primary line (larger, calm light colour);
// the guidance line is secondary (smaller, soft muted colour, not bold).
// The status colour lives mainly on the thin border accent, not the text,
// so nothing glares against the dark card.
const STATUS_NAME_FONT  = 16;        // brand name — primary line
const STATUS_TEXT_FONT  = 14;        // guidance line — secondary, slightly smaller
const CLR_STATUS_NAME    = '#86efac'; // soft green — brand name (positive, brand accent)
const CLR_STATUS_TEXT    = '#dde5ef'; // near-white slate — guidance text (clear, prominent)
const CLR_STATUS_RULE    = '#3a4660'; // thin divider line under the brand name

// ── Hint-box colours ─────────────────────────────────────────────
const CLR_GOOD    = '#86efac'; // green  — player has clear advantage
const CLR_BAD     = '#f87171'; // red    — player is clearly worse
const CLR_NEU     = '#e2e8f0'; // light  — roughly equal position
const CLR_WAIT    = '#7dd3fc'; // sky-blue — engine thinking / opponent turn
const CLR_ERR     = '#fcd34d'; // soft gold — needs attention (token missing, etc.)
const CLR_OK      = '#86efac'; // green  — informational positive (game over won)
const CLR_INFO    = '#a5b4fc'; // soft indigo — neutral guidance (no game / start)
const CLR_GEAR    = '#60a5fa'; // blue   — gear icon (shown only when analysing)
const CLR_HDR     = '#94a3b8'; // muted  — header row text (engine name, depth)
const CLR_GENMATE = '#e2e8f0'; // bright — brand label in hint header

// ── Border colours (match body colour family) ────────────────────
const BRD_GOOD    = '#22c55e'; // green border when player is winning
const BRD_WAIT    = '#0ea5e9'; // blue border while thinking
const BRD_ERR     = '#eab308'; // soft gold border on warnings — noticeable, not glaring
const BRD_INFO    = '#6366f1'; // soft indigo border — neutral guidance
const BRD_DEFAULT = '#2a3447'; // dark border — neutral / idle

// Status messages shown in the hint box (English — default language)
const TXT_NO_TOKEN   = 'Token needed\nClick the toolbar icon to add it';
const TXT_NO_GAME    = 'Start a game vs computer\nto see hints';
const TXT_OPP_TURN   = 'Opponent thinking\u2026';
const TXT_CONNECTING = 'Connecting\u2026';
const TXT_ANALYZING  = 'Analyzing\u2026';
const TXT_ENG_START  = 'Engine starting\u2026';
const TXT_VS_HUMAN   = 'Works only in games\nvs computer';
const TXT_ENG_ERR    = 'Extension error\nTry reloading the page';
const TXT_GAME_OVER  = 'Game over: ';   // status appended after

// ═══════════════════════════════════════════════════════════════════

// ==================== STATE ====================
let cfg = {
  token: '', mode: 'infinite', movetime: 3000,
  enableHints: true, showEval: true, showFullMove: false,
};
const MULTI_PV = 1;

const INIT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ── Debug logging ────────────────────────────────────────────────
// Set DEBUG = true to print diagnostic logs to the console. Kept OFF in
// release for a clean console; a user reporting a bug can flip it to true,
// reload the extension, reproduce, and copy the [GM-DBG] lines. All debug
// output goes through dbg(); production behaviour is unchanged when false.
const DEBUG = false;
function dbg(...args){ if (DEBUG) console.log(...args); }

const _t0 = Date.now();
function tlog(label){ dbg('[GM-DBG] +' + (Date.now()-_t0) + 'ms ' + label); }

let playerColor   = null, botColor = null, currentFen = null, streamCtrl = null;
let gameId        = null, hintEl = null, analyzing = false, hintVisible = true;
let lastFen       = null, moveNum = 1, bgAnalysisFen = null;
let pvLines       = {}, currentJobId = 0, engineName = '';
let analysisTimer = null, analysisStarted = false;
let cloudBannedUntil = 0, gameAllowed = false;
let initialFen = 'startpos', allMoves = '';
let gameOver = false;            // set true on gameEnd → no reconnect
// Reconnect backoff (only used when the live stream drops, e.g. lichess server
// restart). Growth factor φ (golden ratio ≈1.618) gives a gentle ramp: frequent
// early retries to recover fast from short blips, then progressively slower so we
// never hammer a server that is genuinely down. φ grows slower than e, so the
// first few retries stay close together — exactly the soft start we want.
const RECONNECT_BASE   = 3000;       // first retry delay (ms)
const RECONNECT_FACTOR = 1.618;      // φ — golden ratio backoff multiplier
const RECONNECT_MAX    = 30000;      // cap ~30 s
let reconnectDelay = RECONNECT_BASE; // current delay, resets on successful connect
let lastSeenMovesCount = -1;     // track moves seen in gameFull to detect stale reconnects
let staleReconnects = 0;          // count reconnects without move progress → slow backoff

// ==================== GEAR STYLE ====================
function injectGearStyle() {
  if (document.getElementById('gm-style')) return;
  const s = document.createElement('style');
  s.id = 'gm-style';
  s.textContent = '@keyframes gm-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
  (document.head || document.documentElement).appendChild(s);
}

// ==================== FEN FROM STREAM ====================
function fenApplyMoves(baseFen, movesStr) {
  const startFen = (!baseFen || baseFen === 'startpos') ? INIT_FEN : baseFen;
  try {
    const chess = new Chess(startFen);
    if (movesStr && movesStr.trim()) {
      const ucis = movesStr.trim().split(/\s+/);
      let applied = 0;
      for (let uci of ucis) {
        if (!uci || uci.length < 4) continue;
        // Convert classic castling sent in king-takes-rook style (e1h1/e1a1/
        // e8h8/e8a8) to standard king-two-squares notation (e1g1/e1c1/e8g8/e8c8).
        // CRITICAL: only do this when a KING is actually on the from-square.
        // Otherwise a normal rook move along the back rank (e.g. Re8-h8 = e8h8)
        // would be wrongly rewritten to e8g8, corrupting the whole position.
        const fromPiece = chess.get(uci.slice(0, 2));
        if (fromPiece && fromPiece.type === 'k') {
          if (uci === 'e1h1') uci = 'e1g1';
          else if (uci === 'e1a1') uci = 'e1c1';
          else if (uci === 'e8h8') uci = 'e8g8';
          else if (uci === 'e8a8') uci = 'e8c8';
        }
        const result = chess.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] || 'q' });
        if (!result) {
          dbg('[GM-DBG] fenApplyMoves: move rejected uci=' + uci + ' applied=' + applied + ' fen=' + chess.fen());
          break;
        }
        applied++;
      }
    }
    return chess.fen();
  } catch(e) {
    // chess.js rejected the FEN (e.g. lichess custom position FEN quirks).
    // Fall back: compute side-to-move by parity from initialFen + moves count.
    dbg('[GM-DBG] fenApplyMoves ERROR: ' + e.message + ' baseFen=' + baseFen);
    const initSide = startFen.split(' ')[1] || 'w';
    const movesCount = movesStr ? movesStr.trim().split(/\s+/).filter(Boolean).length : 0;
    const side = (movesCount % 2 === 0) ? initSide : (initSide === 'w' ? 'b' : 'w');
    // Rebuild FEN with corrected side-to-move (other fields from startFen)
    const parts = startFen.split(' ');
    parts[1] = side;
    // Reset en-passant and halfmove/fullmove to safe values
    parts[3] = '-';
    parts[4] = parts[4] || '0';
    parts[5] = String(parseInt(parts[5] || '1') + Math.floor(movesCount / 2));
    return parts.join(' ');
  }
}

// ==================== KEEP-ALIVE ====================
function keepBgAlive() {
  try {
    const p = browser.runtime.connect({ name: 'genmate' });
    p.onDisconnect.addListener(() => setTimeout(keepBgAlive, 1000));
  } catch(_) { setTimeout(keepBgAlive, 2000); }
}

// ==================== ANALYSIS WATCHDOG ====================
function startAnalysisTimer() {
  clearAnalysisTimer();
  analysisTimer = setTimeout(() => {
    if (analyzing && !analysisStarted) {
      lastFen = null; analyzing = false;
      browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
      setTimeout(() => analyzePosition(currentFen), 300);
    }
  }, 8000);
}
function clearAnalysisTimer() {
  if (analysisTimer) { clearTimeout(analysisTimer); analysisTimer = null; }
}

// ==================== HINT POSITION ====================
const POS_KEY = 'gm_hint_pos';
function savePos() {
  if (!hintEl) return;
  try { sessionStorage.setItem(POS_KEY, JSON.stringify({ top: hintEl.style.top, left: hintEl.style.left })); } catch(_) {}
}
function restorePos() {
  if (!hintEl) return;
  try {
    const p = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
    if (p?.top)  hintEl.style.top  = p.top;
    if (p?.left) { hintEl.style.left = p.left; hintEl.style.right = 'auto'; }
  } catch(_) {}
}

// ==================== HINT ELEMENT ====================
function ensureHint() {
  if (hintEl && document.contains(hintEl)) return;
  injectGearStyle();

  hintEl = document.createElement('div');
  hintEl.id = 'gm-hint';
  Object.assign(hintEl.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
    background: 'rgba(13,16,22,0.96)', color: '#e6eaf2',
    padding: '12px 16px', borderRadius: '10px',
    font: BODY_FONT + 'px/1.65 Inter,system-ui,Arial,sans-serif',
    border: `1px solid ${BRD_DEFAULT}`, minWidth: '220px',
    boxShadow: '0 4px 24px rgba(0,0,0,.6)',
    cursor: 'grab', userSelect: 'none', transition: 'border-color .2s',
    whiteSpace: 'pre-line',
  });
  hintEl.title = 'Drag to move · Click to re-analyze';
  restorePos();
  if (!hintVisible) hintEl.style.display = 'none';

  let dragged = false;
  hintEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return; dragged = false;
    const r = hintEl.getBoundingClientRect();
    const ox = r.left, oy = r.top, sx = e.clientX, sy = e.clientY;
    hintEl.style.cursor = 'grabbing';
    const mv = ev => {
      dragged = true;
      hintEl.style.left  = (ox + ev.clientX - sx) + 'px';
      hintEl.style.top   = (oy + ev.clientY - sy) + 'px';
      hintEl.style.right = 'auto';
    };
    const up = () => {
      hintEl.style.cursor = 'grab'; savePos();
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  hintEl.addEventListener('click', () => {
    if (dragged) return;
    if (!playerColor) return;
    lastFen = null; pvLines = {}; analyzing = false;
    if (currentFen) analyzePosition(currentFen);
  });
  document.body.appendChild(hintEl);
}

// ==================== SHOW HINT (status messages) ====================
// type: 'ok' = green | 'err' = gold | 'wait' = sky-blue | 'info' = indigo | default = neutral
// The gear icon is an ANALYSIS indicator: it is shown only while the engine is
// actually analysing. Status/guidance messages (no token, no game, etc.) show the
// brand name without a gear, so the icon's meaning stays unambiguous.
// Fully hide the card — used on pages that are not an active vs-computer game,
// so nothing (no dark empty box, no stray status) shows where it doesn't belong.
function hideCard() {
  if (hintEl) hintEl.style.display = 'none';
}

function showHint(text, type) {
  ensureHint();
  if (hintEl) hintEl.style.display = hintVisible ? '' : 'none';
  if (!hintVisible) return;

  // Status colour is applied to the border accent only (see below).
  const border =
    type === 'ok'   ? BRD_GOOD    :
    type === 'err'  ? BRD_ERR     :
    type === 'wait' ? BRD_WAIT    :
    type === 'info' ? BRD_INFO    : BRD_DEFAULT;

  // Gear is shown only during real analysis; for status messages it is hidden.
  const gearHtml = analyzing
    ? `<span id="gm-gear" style="display:inline-block;`
      + `animation:gm-spin 2s linear infinite;animation-play-state:running;`
      + `color:${CLR_GEAR};margin-right:5px">\u2699\uFE0E</span>`
    : '';

  // Primary line = brand name (calm, larger). Secondary line = guidance text
  // (smaller, soft muted). Status colour is carried by the border, not the text,
  // so the card stays easy on the eyes.
  hintEl.innerHTML =
    `<div style="font-size:${STATUS_NAME_FONT}px;color:${CLR_STATUS_NAME};`
    + `margin-bottom:8px;font-weight:600;text-align:center;letter-spacing:.4px">`
    + gearHtml
    + `${BRAND_NAME}</div>`
    // Thin centred divider, narrower than the card, separates name from guidance.
    + `<div style="height:1px;width:60%;margin:0 auto 9px;`
    + `background:${CLR_STATUS_RULE}"></div>`
    + `<div style="font-size:${STATUS_TEXT_FONT}px;font-weight:600;text-align:center;`
    + `color:${CLR_STATUS_TEXT};white-space:pre-line;line-height:1.5">${text}</div>`;

  hintEl.style.textAlign  = 'center';
  hintEl.style.fontWeight = 'normal';
  hintEl.style.borderColor = border;
}

// ==================== MOVE FORMAT ====================
const PIECE_EN = { p:'Pawn', n:'Knight', b:'Bishop', r:'Rook', q:'Queen', k:'King' };
const PROMO_EN = { q:'Q', r:'R', b:'B', n:'N' };

function charAtSq(fen, sq) {
  if (!sq || sq.length < 2) return null;
  const f = sq.charCodeAt(0) - 97, rk = 8 - parseInt(sq[1]);
  if (f < 0 || f > 7 || rk < 0 || rk > 7) return null;
  const rows = fen.split(' ')[0].split('/');
  let c = 0;
  for (const ch of (rows[rk] || '')) {
    if (/\d/.test(ch)) { c += +ch; continue; }
    if (c === f) return ch; c++;
  }
  return null;
}
function pieceAt(fen, mv) {
  const ch = charAtSq(fen, mv ? mv.slice(0,2) : '');
  return ch ? (PIECE_EN[ch.toLowerCase()] || '?') : '?';
}
function fmtMove(fen, mv) {
  if (!fen || !mv || mv.length < 4) return mv;
  const from = mv.slice(0,2), to = mv.slice(2,4), promo = mv[4];
  const srcCh = charAtSq(fen, from);
  if (!srcCh) return mv;
  const piece = srcCh.toLowerCase();
  if (piece === 'k') {
    const df = to.charCodeAt(0) - from.charCodeAt(0);
    if (df ===  2) return '0-0';
    if (df === -2) return '0-0-0';
  }
  const dstCh = charAtSq(fen, to);
  const isCapture = !!dstCh || (piece === 'p' && from[0] !== to[0]);
  const promoStr  = promo ? '=' + (PROMO_EN[promo] || promo.toUpperCase()) : '';
  return from + (isCapture ? 'x' : '-') + to + promoStr;
}
function fmtMoveWithPiece(fen, mv) {
  const move = fmtMove(fen, mv);
  if (move === '0-0' || move === '0-0-0') return move;
  const srcCh = charAtSq(fen, mv ? mv.slice(0,2) : '');
  if (!srcCh) return move;
  const p = srcCh.toLowerCase();
  const name = PIECE_EN[p] || '';
  return (name && p !== 'p') ? name + ' ' + move : move;
}

// ==================== RENDER PV LINES ====================
// Persistent gear DOM — animation never restarts, no visual jump
function renderPvLines() {
  // Drop any line whose analysed position (snapFen) no longer matches the board
  // (currentFen). In infinite mode the engine can still emit lines for the
  // previous position right after the opponent moves; rendering those would show
  // a move that is illegal on the current board (e.g. a blocked pawn promotion).
  for (const k of Object.keys(pvLines)) {
    const L = pvLines[k];
    if (L && L.snapFen && currentFen && L.snapFen !== currentFen) {
      dbg('[GM-DBG] renderPvLines: DROP stale line [' + k + '] move=' + L.bestMove
        + ' (' + fmtMoveWithPiece(L.snapFen, L.bestMove) + ')'
        + ' engineFen=' + L.snapFen + ' boardFen=' + currentFen);
      delete pvLines[k];
    }
  }

  const keys = Object.keys(pvLines).map(Number).sort((a,b) => a-b);
  if (!keys.length) return;

  const first = pvLines[keys[0]];
  const depth = first.depth || 0;
  const dots  = first.isBlack ? ' ...' : '';

  let rows = '';
  for (const k of keys) {
    const L = pvLines[k];
    let evalStr = '', evalClr = CLR_NEU;

    if (L.mate !== undefined) {
      // Sign: chess standard (positive = White delivers mate)
      const signChar = L.mate >= 0 ? 'M+' : 'M\u2212';
      evalStr = '= ' + signChar + Math.abs(L.mate);
      // Colour: from token-holder's POV
      const pov = (playerColor || 'w') === 'b' ? -L.mate : L.mate;
      evalClr = pov > 0 ? CLR_GOOD : CLR_BAD;

    } else if (L.cp !== undefined) {
      // Sign: chess standard (+ = White better, − = Black better)
      if (cfg.showEval) {
        const abs = (Math.abs(L.cp) / 100).toFixed(2);
        evalStr = (L.cp >= 0 ? '= +' : '= \u2212') + abs;
      }
      // Colour: from token-holder's POV
      // White player: pov = L.cp  (positive → White better → green)
      // Black player: pov = -L.cp (negative engine score → Black better → green)
      const pov = (playerColor || 'w') === 'b' ? -L.cp : L.cp;
      evalClr = pov > EVAL_GOOD_THRESHOLD  ? CLR_GOOD :
                pov < -EVAL_BAD_THRESHOLD   ? CLR_BAD  : CLR_NEU;
    }

    const moveTxt = cfg.showFullMove ? fmtMoveWithPiece(L.snapFen, L.bestMove) : L.piece;

    rows += '<tr>'
      + `<td style="padding:3px 8px 3px 0;color:${CLR_GEAR};font-weight:700">[${k}]</td>`
      + `<td style="padding:3px 10px 3px 0;color:${CLR_NEU}">${moveNum})${dots}</td>`
      + `<td style="padding:3px 12px 3px 0;color:${evalClr};font-weight:700">${moveTxt}</td>`
      + `<td style="padding:3px 0;color:${evalClr};text-align:right">${evalStr}</td>`
      + '</tr>';
  }

  ensureHint();
  if (!hintVisible) return;

  // Rebuild DOM only when needed — keeps gear animation running smoothly
  let gearEl = hintEl.querySelector('#gm-gear');
  if (!gearEl || !hintEl.querySelector('#gm-body')) {
    hintEl.innerHTML =
      `<div id="gm-hdr" style="font-size:${HDR_FONT}px;color:${CLR_HDR};margin-bottom:6px;font-weight:600">`
      + `<span id="gm-gear" style="display:inline-block;`
      + `animation:gm-spin 2s linear infinite;animation-play-state:running;`
      + `color:${CLR_GEAR};margin-right:5px">\u2699\uFE0E</span>`
      + '<span id="gm-ename"></span>'
      + '<span id="gm-dtext"></span>'
      + '</div>'
      + '<div id="gm-body"></div>';
    gearEl = hintEl.querySelector('#gm-gear');
  }

  gearEl.style.animationPlayState = analyzing ? 'running' : 'paused';
  gearEl.style.color = analyzing ? CLR_GEAR : BRD_GOOD;

  const enameEl = hintEl.querySelector('#gm-ename');
  if (enameEl) enameEl.innerHTML = engineName
    ? `<span style="color:${CLR_GEAR}">${engineName}</span> · ` : '';

  const dtextEl = hintEl.querySelector('#gm-dtext');
  if (dtextEl) dtextEl.textContent = 'Depth: ' + depth;

  const bodyEl = hintEl.querySelector('#gm-body');
  if (bodyEl) bodyEl.innerHTML =
    `<table style="border-collapse:collapse;font-size:${BODY_FONT}px">${rows}</table>`;

  hintEl.style.textAlign   = 'left';
  hintEl.style.fontWeight  = 'normal';
  hintEl.style.borderColor = BRD_GOOD;
}

// ==================== CLOUD EVAL ====================
async function cloudEval(fen) {
  if (Date.now() < cloudBannedUntil) return null;
  try {
    const r = await fetch(
      'https://lichess.org/api/cloud-eval?fen=' + encodeURIComponent(fen) + '&multiPv=1');
    if (r.status === 429) { cloudBannedUntil = Date.now() + 60000; return null; }
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.pvs?.length) return null;
    return d.pvs.slice(0,1).map((pv,i) => ({
      bestMove: pv.moves.trim().split(' ')[0],
      cp: pv.cp, mate: pv.mate, depth: d.depth, pvIdx: i+1,
    }));
  } catch(_) { return null; }
}

// ==================== ANALYZE ====================
async function analyzePosition(fen) {
  if (!cfg.enableHints || !fen || !gameAllowed) return;
  if (fen === lastFen && analyzing) return;

  const toMove = fen.split(' ')[1];
  // isMyTurn: true when the side to move is NOT the AI.
  // playerColor is a hint but may be wrong for custom starting positions,
  // so we rely on botColor (derived from stream data, stored at gameFull time).
  const isBotTurn = toMove === botColor;
  dbg('[GM-DBG] analyze: toMove='+toMove+' playerColor='+playerColor+' botColor='+botColor+' isBotTurn='+isBotTurn+' gameAllowed='+gameAllowed);
  if (botColor && isBotTurn) {
    clearAnalysisTimer();
    showHint(TXT_OPP_TURN, 'wait');
    if (analyzing) {
      browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
      analyzing = false;
    }
    return;
  }

  if (analyzing) browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});

  lastFen = fen; analyzing = true; analysisStarted = false;
  currentJobId++; const myJobId = currentJobId;
  bgAnalysisFen = fen; pvLines = {};
  showHint(TXT_ANALYZING, 'wait');

  // Cloud-eval runs in PARALLEL — it must never delay the local engine start.
  // Previously we awaited it here, which stalled the hint whenever lichess was
  // slow to answer. Now the engine starts immediately and the cloud result, if
  // it arrives and is still relevant, is merged in as a quick preliminary line.
  cloudEval(fen).then(cloud => {
    if (!cloud || myJobId !== currentJobId) return;
    // Only use cloud as a preview if the engine hasn't produced lines yet.
    if (Object.keys(pvLines).length > 0) return;
    const isBlack = fen.split(' ')[1] === 'b';
    cloud.forEach(cl => {
      const piece = pieceAt(fen, cl.bestMove);
      if (piece !== '?') {
        // lichess cloud-eval cp/mate is white's POV (standard) — no conversion needed
        pvLines[cl.pvIdx] = {
          depth: cl.depth, bestMove: cl.bestMove, piece, snapFen: fen,
          cp: cl.cp, mate: cl.mate, isBlack,
        };
      }
    });
    renderPvLines();
  }).catch(() => {});

  // Start the local engine right away — this is the hot path for the hint.
  analyzing = true;
  startAnalysisTimer(); // watchdog: сброс если background не ответит за 8s
  tlog('ENGINE_ANALYZE sent jobId=' + myJobId);
  browser.runtime.sendMessage({
    type: 'ENGINE_ANALYZE', fen,
    movetime: cfg.movetime || 3000,
    infinite: cfg.mode === 'infinite',
    multiPv: MULTI_PV, jobId: myJobId,
  }).then(resp => {
    tlog('ENGINE_ANALYZE resp ok=' + (resp&&resp.ok) + ' ready=' + (resp&&resp.ready));
    if (!resp?.ok) { showHint(TXT_ENG_ERR, 'err'); analyzing = false; clearAnalysisTimer(); return; }
    if (!resp.ready) showHint(TXT_ENG_START, 'wait');
    // watchdog already running — reset it now that background confirmed
    startAnalysisTimer();
  }).catch(() => { showHint(TXT_ENG_ERR, 'err'); analyzing = false; clearAnalysisTimer(); });
}

// ==================== MESSAGES FROM BACKGROUND ====================
browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'ENGINE_NAME') { engineName = msg.name || ''; return; }

  if (msg.type === 'ENGINE_READY') {
    tlog('ENGINE_READY received');
    if (!engineName)
      browser.runtime.sendMessage({ type: 'ENGINE_STATUS' })
        .then(r => { if (r?.engineName) engineName = r.engineName; }).catch(() => {});
    if (currentFen && bgAnalysisFen !== currentFen) analyzePosition(currentFen);
    return;
  }

  if (msg.type === 'ENGINE_LINE') {
    if (msg.jobId !== currentJobId || bgAnalysisFen !== currentFen) return;
    const ln = msg.line || '';
    if (ln.startsWith('info ')) {
      if (!analysisStarted) { analysisStarted = true; clearAnalysisTimer(); }
      const dm  = ln.match(/\bdepth\s+(\d+)/);
      const cm  = ln.match(/\bscore\s+cp\s+(-?\d+)/);
      const mm  = ln.match(/\bscore\s+mate\s+(-?\d+)/);
      const pm  = ln.match(/\bpv\s+(\S+)/);
      const mpm = ln.match(/\bmultipv\s+(\d+)/);
      if (pm && dm && +dm[1] > 0) {
        const pvIdx = mpm ? +mpm[1] : 1;
        const snap  = bgAnalysisFen;
        const piece = pieceAt(snap, pm[1]);
        const newDepth = +dm[1];
        const prevDepth = pvLines[pvIdx] ? pvLines[pvIdx].depth : 0;
        // Обновляем только если глубина растёт (не перезаписываем cloud более мелким depth)
        if (piece !== '?' && newDepth >= prevDepth) {
          // UCI score cp/mate is side-to-move POV. Convert to white's POV (our standard).
          const engIsBlack = snap.split(' ')[1] === 'b';
          const rawCp   = cm ? +cm[1] : undefined;
          const rawMate = mm ? +mm[1] : undefined;
          const engCp   = (rawCp   !== undefined && engIsBlack) ? -rawCp   : rawCp;
          const engMate = (rawMate !== undefined && engIsBlack) ? -rawMate : rawMate;
          pvLines[pvIdx] = {
            depth: newDepth, bestMove: pm[1], piece, snapFen: snap,
            cp: engCp, mate: engMate,
            isBlack: engIsBlack,
          };
          renderPvLines();
        }
      }
    }
    if (ln.startsWith('bestmove ')) {
      clearAnalysisTimer();
      analyzing = false;
    }
    return;
  }

  if (msg.type === 'HINT_HIDE') {
    hintVisible = false;
    if (hintEl) hintEl.style.display = 'none';
    if (analyzing) {
      browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
      analyzing = false;
    }
    return;
  }

  if (msg.type === 'HINT_SHOW') {
    hintVisible = true;
    ensureHint();
    if (hintEl) hintEl.style.display = '';
    lastFen = null; pvLines = {};
    if (currentFen) analyzePosition(currentFen);
    return;
  }

  if (msg.type === 'FLIP_COLOR') {
    playerColor = playerColor === 'w' ? 'b' : (playerColor === 'b' ? 'w' : 'w');
    pvLines = {}; lastFen = null; analyzing = false;
    if (currentFen) analyzePosition(currentFen);
    return;
  }

  if (msg.type === 'SETTINGS_CHANGED') {
    browser.storage.sync.get(['token','mode','movetime','enableHints','showEval','showFullMove'])
      .then(s => {
        cfg = Object.assign({}, cfg, s);
        if (!cfg.enableHints) { showHint('Hints off'); return; }
        pvLines = {}; lastFen = null; analyzing = false;
        if (currentFen) analyzePosition(currentFen);
      });
  }
});

// ==================== STREAM ====================
function checkGameAllowed(data) {
  const white = data.white || {}, black = data.black || {};

  // ── Variant gate (v1: standard chess only) ──────────────────────
  // The bundled chess.js is classic-only — it cannot apply Chess960 castling,
  // which silently corrupts move replay (engine ends up analysing a stale
  // position). Until 960 is properly supported, treat any non-standard variant
  // as "no active game": hide the card entirely, run nothing. Detection uses
  // lichess's variant field, with an initialFen fallback for safety.
  const variant = (data.variant && (data.variant.key || data.variant.name) || '').toLowerCase();
  const isStandard = !variant || variant === 'standard' || variant === 'fromposition';
  const initFenStr = data.initialFen || '';
  // A non-standard back-rank in initialFen (not the classic RNBQKBNR) signals 960.
  const backRank = initFenStr && initFenStr !== 'startpos'
    ? (initFenStr.split(' ')[0].split('/')[7] || '') : '';
  const looks960 = backRank && backRank.toUpperCase() !== 'RNBQKBNR'
    && /^[RNBQK]{8}$/i.test(backRank);
  if (!isStandard || variant === 'chess960' || looks960) {
    gameAllowed = false;
    dbg('[GM-DBG] unsupported variant -> hide card (variant=' + variant + ' backRank=' + backRank + ')');
    hideCard();
    return false;
  }

  const whiteIsAi = white.aiLevel !== undefined || typeof white.ai !== 'undefined' ||
    (white.name && white.name.toLowerCase().includes('stockfish'));
  const blackIsAi = black.aiLevel !== undefined || typeof black.ai !== 'undefined' ||
    (black.name && black.name.toLowerCase().includes('stockfish'));

  if (!whiteIsAi && !blackIsAi) {
    gameAllowed = false;
    showHint(TXT_VS_HUMAN, 'err');
    return false;
  }

  gameAllowed = true;
  // botColor = colour of the AI side. playerColor = colour of the human.
  // We detect which side is human by the presence of a real user id (bots have aiLevel, not id).
  // This works for arbitrary positions regardless of who moves first in initialFen.
  botColor    = whiteIsAi ? 'w' : 'b';
  playerColor = whiteIsAi ? 'b' : 'w';
  dbg('[GM-DBG] gameFull: whiteIsAi='+whiteIsAi+' botColor='+botColor+' playerColor='+playerColor);
  return true;
}

function processCurrentPosition() {
  const fen = fenApplyMoves(initialFen, allMoves);
  moveNum = parseInt(fen.split(' ')[5] || '1');

  if (fen !== currentFen) {
    // One-shot diagnostic per position change: full move list + final FEN.
    // Lets us replay the exact UCI moves the plugin received and find where the
    // reconstructed position diverges from the real board. Logs once per new
    // position (not per engine tick), so no console spam.
    dbg('[GM-DBG] processPos NEW: initFen=' + initialFen
      + ' | finalFen=' + fen
      + ' | movesCount=' + (allMoves.trim().split(/\s+/).filter(Boolean).length)
      + ' | moves=' + allMoves.trim());
    clearAnalysisTimer();
    if (analyzing) {
      browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
      analyzing = false;
    }
    currentFen = fen; lastFen = null; pvLines = {};
    analyzePosition(fen);
  }
}

// Centralised end-of-game handling: stop the engine, abort the live stream,
// and show a calm "Game over" message. After this no reconnect happens (the
// gameOver flag gates all reconnect paths), so the card no longer flickers
// "Connecting" on a finished game.
function endGame(message) {
  clearAnalysisTimer();
  gameOver = true;
  analyzing = false;
  browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
  if (streamCtrl) { streamCtrl.abort(); streamCtrl = null; }
  if (_moveObserver) { _moveObserver.disconnect(); _moveObserver = null; }
  showHint(message, 'ok');
}

async function onStreamEvent(data) {
  if (data.type === 'gameFull') {
    if (!checkGameAllowed(data)) return;
    initialFen = data.initialFen || 'startpos';
    const state = data.state || {};
    allMoves = state.moves || '';
    const movesCount = allMoves.trim().split(/\s+/).filter(Boolean).length;
    dbg('[GM-DBG] gameFull: moves='+movesCount+' status='+(state.status||'?')+' initFen='+(initialFen==='startpos'?'startpos':initialFen)+' initSide='+(initialFen==='startpos'?'w':initialFen.split(' ')[1]));
    const st = state.status;
    if (st && st !== 'started' && st !== 'created') {
      endGame(TXT_GAME_OVER + st);
      return;
    }
    const movesAdvanced = movesCount > lastSeenMovesCount;
    lastSeenMovesCount = movesCount;
    // Force re-analyze if moves advanced (new move arrived via reconnect gameFull)
    if (movesAdvanced) { lastFen = null; pvLines = {}; staleReconnects = 0; }
    processCurrentPosition();
    return;
  }

  if (!gameAllowed) return;

  if (data.type === 'gameState') {
    dbg('[GM-DBG] gameState: moves='+((data.moves||'').trim().split(/\s+/).filter(Boolean).length)+' status='+(data.status||'?'));
    const st = data.status;
    if (st && st !== 'started' && st !== 'created') {
      endGame(TXT_GAME_OVER + st);
      return;
    }
    const newMovesCount = (data.moves || '').trim().split(/\s+/).filter(Boolean).length;
    if (newMovesCount > lastSeenMovesCount) {
      lastSeenMovesCount = newMovesCount;
      lastFen = null; currentFen = null; pvLines = {};
    }
    allMoves = data.moves || '';
    processCurrentPosition();
  }
}

// -- reconnect helper --------------------------------------------------
// Schedules reconnect with golden-ratio backoff (factor φ), respecting
// document visibility. No reconnect after gameOver.
function scheduleReconnect(gid, token) {
  if (gameOver) return;
  if (!gid || !token) return;

  const delay = reconnectDelay;
  reconnectDelay = Math.min(Math.round(reconnectDelay * RECONNECT_FACTOR), RECONNECT_MAX);
  dbg('[GM-DBG] scheduleReconnect: delay='+delay+' visible='+(document.visibilityState==='visible'));

  if (document.visibilityState === 'visible') {
    setTimeout(() => {
      if (!gameOver && gameId === gid) startStream(gid, token);
    }, delay);
  } else {
    // Hidden tab: reconnect once when user comes back
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      if (!gameOver && gameId === gid) startStream(gid, token);
    };
    document.addEventListener('visibilitychange', onVisible);
  }
}

async function startStream(gid, token) {
  if (streamCtrl) streamCtrl.abort();
  streamCtrl = new AbortController();
  showHint(TXT_CONNECTING, 'wait');
  let streamEnded = false;
  try {
    const r = await fetch('https://lichess.org/api/board/game/stream/' + gid,
      { headers: { Authorization: 'Bearer ' + token }, signal: streamCtrl.signal });
    dbg('[GM-DBG] stream HTTP: status='+r.status+' gid='+gid);
    if (!r.ok) {
      showHint(
        r.status === 404 ? TXT_NO_GAME : '\u26a0\ufe0f HTTP ' + r.status + '\nCheck token in settings',
        r.status === 404 ? 'info' : 'err');
      return;
    }
    reconnectDelay = RECONNECT_BASE;                     // successful connect -- reset backoff
    startMoveObserver(gid, token);               // watch move list for player moves
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', eventsReceived = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) { streamEnded = true; break; }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        const s = ln.trim(); if (!s) continue;
        eventsReceived++;
        try { await onStreamEvent(JSON.parse(s)); } catch(_) {}
      }
    }
  } catch(e) {
    if (e.name === 'AbortError') return;
    scheduleReconnect(gid, token);
    return;
  }
  // Stream ended cleanly but game not over -> reconnect
  // If only gameFull arrived (eventsReceived<=1) stream closed before gameState:
  // reconnect immediately (state may be stale by one move)
  dbg('[GM-DBG] stream done: eventsReceived='+eventsReceived+' gameOver='+gameOver);
  if (streamEnded && !gameOver) {
    if (eventsReceived <= 1) {
      lastFen = null; pvLines = {};
      if (analyzing) {
        browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
        analyzing = false;
      }
      staleReconnects++;
      dbg('[GM-DBG] fast-reconnect: staleReconnects='+staleReconnects+' moves='+lastSeenMovesCount);
      if (staleReconnects === 1) {
        // First attempt: fast reconnect to catch move that arrived right after stream closed
        reconnectDelay = RECONNECT_BASE;
        setTimeout(() => {
          if (!gameOver && gameId === gid) startStream(gid, token);
        }, 400);
      } else {
        // Subsequent stale reconnects: slow backoff (don't spam lichess)
        // Stream will reopen and get updated gameFull when player makes a move
        scheduleReconnect(gid, token);
      }
    } else {
      scheduleReconnect(gid, token);
    }
  }
}

// ==================== INIT ====================
function gameIdFromUrl(u) {
  // Accept both 8-char (player) and 12-char (full/spectator) game ids.
  // The 8-char id is the prefix of the 12-char id, so we capture up to 12
  // and trim to the canonical 8-char form used by the Board API.
  const m = u.match(/lichess\.org\/([a-zA-Z0-9]{8,12})(\/|$|#|\?)/);
  return m ? m[1].slice(0, 8) : null;
}

async function init() {
  const s = await browser.storage.sync.get(
    ['token','mode','movetime','enableHints','showEval','showFullMove']);
  cfg = Object.assign({}, cfg, s);
  ensureHint();

  const gid = gameIdFromUrl(location.href);
  tlog('init: gid=' + gid + ' tries=' + _initTries + ' url=' + location.href);
  if (!gid) {
    // On rematch the URL may not yet contain the new game id (lichess updates it
    // slightly after the DOM mutation). Retry a few times before giving up.
    if (_initTries < 8) { _initTries++; setTimeout(init, 400); return; }
    _initTries = 0;
    // Not a game page (lobby, profile, training, etc.) — hide the card entirely
    // instead of showing a stray dark box where it doesn't belong.
    hideCard(); return;
  }
  _initTries = 0;

  gameId = gid;
  if (!cfg.token) { showHint(TXT_NO_TOKEN, 'err'); return; }

  keepBgAlive();
  tlog('init: ENGINE_REGISTER sent');
  browser.runtime.sendMessage({ type: 'ENGINE_REGISTER' })
    .then(r => { tlog('init: ENGINE_REGISTER ok'); if (r?.engineName) engineName = r.engineName; }).catch(() => {});
  startStream(gameId, cfg.token);
}

let _lastUrl = location.href;
let _initTries = 0;

// MoveObserver: when a new move appears on the board (player or AI made a move)
// and the stream is stale (no gameState flowing), reconnect immediately.
// This avoids waiting for backoff delay after the player's move.
// Uses lichess move list element — no FEN reading from DOM, just detects new moves.
let _moveObserver = null;
function startMoveObserver(gid, token) {
  if (_moveObserver) { _moveObserver.disconnect(); _moveObserver = null; }
  const moveList = document.querySelector('l4x, .moves');
  if (!moveList) return;
  let lastChildCount = moveList.querySelectorAll('kwdb, move, m2').length;
  _moveObserver = new MutationObserver(() => {
    if (gameOver || gameId !== gid) return;
    const newCount = moveList.querySelectorAll('kwdb, move, m2').length;
    if (newCount <= lastChildCount) return;
    lastChildCount = newCount;
    // New move on board — if stream is stale, reconnect now
    if (staleReconnects > 1) {
      dbg('[GM-DBG] moveObserver: new move detected, reconnecting');
      staleReconnects = 1; // allow one fast reconnect
      reconnectDelay = RECONNECT_BASE;
      if (streamCtrl) streamCtrl.abort();
      setTimeout(() => {
        if (!gameOver && gameId === gid) startStream(gid, token);
      }, 200);
    }
  });
  _moveObserver.observe(moveList, { childList: true, subtree: true });
}

new MutationObserver(() => {
  if (location.href === _lastUrl) return;
  tlog('URL changed (rematch?): ' + _lastUrl + ' -> ' + location.href);
  _lastUrl = location.href;
  _initTries = 0;
  if (streamCtrl) streamCtrl.abort();
  clearAnalysisTimer();
  gameId = null; playerColor = null; botColor = null; currentFen = null;
  lastFen = null; analyzing = false; bgAnalysisFen = null;
  pvLines = {}; gameAllowed = false;
  initialFen = 'startpos'; allMoves = '';
  gameOver = false; reconnectDelay = RECONNECT_BASE; lastSeenMovesCount = -1; staleReconnects = 0;
  if (_moveObserver) { _moveObserver.disconnect(); _moveObserver = null; }
  setTimeout(init, 600);
}).observe(document.documentElement, { childList: true, subtree: true });

init();
