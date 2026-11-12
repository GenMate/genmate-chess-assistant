// popup.js — GenMate Chess Assistant v1
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Uses common.js (loaded first by popup.html): loadSettings, saveSettings,
// removeToken, validateNews, safeNewsUrl.

// GENMATE: UI VISIBILITY FLAGS (keep)
// Flip to false to HIDE a block in the popup. The markup and logic
// STAY in code — only display is toggled. Set true to show again.
const SHOW_ENGINE_SELECTOR = true;   // Engine chooser (lite / full)

// Seconds-per-move helpers. sanitizeSec: keep digits + one separator while
// typing, accepting both "." and ",". fmtSec: ms → a clean seconds string
// ("3", "3.5") with no trailing ".0".
function sanitizeSec(raw) {
  let v = String(raw).replace(',', '.').replace(/[^0-9.]/g, '');
  const i = v.indexOf('.');
  if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
  return v;
}
function fmtSec(ms) {
  const sec = (ms || 0) / 1000;
  return Number.isInteger(sec) ? String(sec) : String(parseFloat(sec.toFixed(3)));
}

function isLichessUrl(u) {
  try { const p = new URL(u); return p.protocol === 'https:' && p.hostname === 'lichess.org'; }
  catch (_) { return false; }
}

document.addEventListener('DOMContentLoaded', async () => {
  const tokenBlock    = document.getElementById('token-block');
  const tokenInput    = document.getElementById('token-input');
  const modeSelect    = document.getElementById('mode-select');
  const pvSelect      = document.getElementById('pv-select');
  const movetimeInput = document.getElementById('movetime-input');
  const showEval      = document.getElementById('show-eval');
  const showFrom      = document.getElementById('show-from');
  const hintsToggle   = document.getElementById('engine-toggle');
  const engineSelect  = document.getElementById('engine-select');
  const engineSection = document.getElementById('engine-section');
  const gmSubtitle    = document.getElementById('gm-subtitle');
  const tokenSave     = document.getElementById('token-save');
  const tokenCheck    = document.getElementById('token-check');
  const tokenRemove   = document.getElementById('token-remove');
  const statusLine    = document.getElementById('popup-status');
  const consentNeeded = document.getElementById('consent-needed');
  const dataSettings  = document.getElementById('data-settings');

  // Version in the subtitle comes from the manifest (no hard-coded number).
  const SUBTITLE = 'CHESS ASSISTANT v' + browser.runtime.getManifest().version;
  if (gmSubtitle) gmSubtitle.textContent = SUBTITLE;

  // Status line: errors in gold, confirmations in green. Never claims success
  // that did not happen.
  function showStatus(text, ok) {
    if (!statusLine) return;
    statusLine.textContent = text || '';
    statusLine.className = 'popup-status' + (ok ? ' ok' : '');
    statusLine.style.display = text ? '' : 'none';
  }

  // Keep the chooser visible; never offer a missing engine as usable.
  const engineFullOpt = engineSelect ? engineSelect.querySelector('option[value="full"]') : null;
  if (engineSection) engineSection.style.display = SHOW_ENGINE_SELECTOR ? '' : 'none';
  if (engineFullOpt) engineFullOpt.disabled = true;
  browser.runtime.sendMessage({ type: 'GET_ENGINE' }).then(r => {
    if (!engineFullOpt) return;
    const available = !!(r && r.fullAvailable);
    engineFullOpt.disabled = !available;
    engineFullOpt.textContent = available ? 'Stockfish 19 Full' : 'Stockfish 19 Full (unavailable)';
  }).catch(() => {});

  // ---- Active Lichess tab (content script) ----
  // Returns the reply, or null when there is no Lichess tab / no content script.
  async function sendToTab(msg) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab || !Number.isInteger(tab.id) || !isLichessUrl(tab.url)) return null;
      const r = await browser.tabs.sendMessage(tab.id, msg);
      return r === undefined ? { ok: true } : r;
    } catch(_) { return null; }
  }

  // Instant-apply: every option writes to storage.local; the page picks the
  // change up through storage.onChanged. There is NO Save button.
  async function apply(patch) {
    try { await saveSettings(patch); showStatus(''); }
    catch (_) { showStatus('Could not save the setting: extension storage unavailable'); }
  }

  // ---- Load saved settings ----
  let s;
  try { s = await loadSettings(); }
  catch (_) {
    s = Object.assign({}, SETTINGS_DEFAULTS);
    showStatus('Extension storage unavailable');
  }

  // ---- Token UI: one-time entry, collapse after save, ☑ indicator ----
  const BOX_EMPTY = '☐';   // ☐
  const BOX_TICK  = '☑';   // ☑
  function showTokenEntry() {
    tokenBlock.style.display = '';
    if (tokenCheck) tokenCheck.textContent = BOX_EMPTY;
    if (tokenRemove) tokenRemove.style.display = 'none';
  }
  function showTokenSaved() {
    tokenBlock.style.display = 'none';
    if (tokenCheck) tokenCheck.textContent = BOX_TICK;
    if (tokenRemove) tokenRemove.style.display = '';
  }
  if (s.token) { showTokenSaved(); }
  else         { showTokenEntry(); }

  // ---- Load + bind options (instant-apply) ----
  const mode = s.mode || 'infinite';
  modeSelect.value = mode;
  movetimeInput.style.display = (mode === 'timed') ? '' : 'none';
  const analysisRow = document.querySelector('.analysis-row');
  if (analysisRow) analysisRow.className = 'row2 analysis-row' + (mode === 'timed' ? ' timed' : '');
  movetimeInput.value = fmtSec(s.movetime || 3000);
  showEval.checked = s.showEval !== false;       // default ON
  showFrom.checked = (s.hintMode === 'origin');  // default ON; preserve an explicitly saved choice
  pvSelect.value = String(s.multiPv || 1);

  modeSelect.addEventListener('change', () => {
    const timed = modeSelect.value === 'timed';
    movetimeInput.style.display = timed ? '' : 'none';
    if (analysisRow) analysisRow.className = 'row2 analysis-row' + (timed ? ' timed' : '');
    apply({ mode: modeSelect.value });
  });

  // Seconds-per-move: typed by hand, decimals allowed. Accept "." or "," and
  // normalise to a dot; block every other character. e.g. "3,5" -> 3.5s.
  movetimeInput.addEventListener('input', () => {
    movetimeInput.value = sanitizeSec(movetimeInput.value);
  });
  movetimeInput.addEventListener('change', () => {
    let sec = parseFloat(movetimeInput.value.replace(',', '.'));
    if (!isFinite(sec) || sec <= 0) sec = 3;
    let ms = Math.round(sec * 1000);
    ms = Math.max(100, Math.min(ms, 300000));   // 0.1 s … 300 s
    movetimeInput.value = fmtSec(ms);
    apply({ movetime: ms });
  });

  pvSelect.addEventListener('change', () => {
    const value = Number(pvSelect.value);
    apply({ multiPv: [1, 2, 3].includes(value) ? value : 1 });
  });
  showEval.addEventListener('change', () => apply({ showEval: showEval.checked }));
  // From-square ON -> "Rook d2 ►"; OFF -> piece type only "Rook". Master overrides.
  showFrom.addEventListener('change', () => apply({ hintMode: showFrom.checked ? 'origin' : 'piece' }));

  // ---- Engine selector ----
  const engineChoice = (s.engine === 'lite' || s.engine === 'full') ? s.engine : 'lite';
  if (engineSelect) engineSelect.value = engineChoice;
  if (engineSelect) {
    engineSelect.addEventListener('change', async () => {
      // Hot-swap: background tears down the worker and boots the chosen one.
      try {
        const r = await browser.runtime.sendMessage({ type: 'ENGINE_SWITCH', engine: engineSelect.value });
        if (!r || !r.ok) {
          if (r && r.engine) engineSelect.value = r.engine;
          showStatus('Could not switch the engine');
        }
      }
      catch(_) { showStatus('Could not switch the engine'); }
    });
  }

  // ---- Token: save / remove ----
  if (tokenSave) {
    tokenSave.onclick = async () => {
      const t = tokenInput.value.trim();
      if (!t) return;
      if (!validTokenText(t)) {
        showStatus('Token not saved: use printable ASCII characters without spaces');
        return;
      }
      try {
        await saveSettings({ token: t });
      } catch (_) {
        showStatus('Token not saved: extension storage unavailable');
        return;
      }
      tokenInput.value = '';
      showTokenSaved();
      showStatus('Token saved in this browser', true);
    };
  }

  // Remove token: stop using it in every tab first, then delete the local copy
  // and request deletion of the old Firefox Sync copy (version 1.1.0 kept the
  // token there). Success is reported only for what actually completed.
  async function doRemoveToken() {
    try { await browser.runtime.sendMessage({ type: 'TOKEN_CLEARED' }); } catch (_) {}
    const r = await removeToken();
    if (!r.local) {
      showStatus('Token NOT removed: extension storage unavailable. Hints stay stopped until the page is reloaded.');
      return;
    }
    tokenInput.value = '';
    showTokenEntry();
    if (r.sync) showStatus('Token removed from this browser; deletion of the old Firefox Sync copy was requested.', true);
    else showStatus('Token removed from this browser, but the old Firefox Sync copy could not be deleted (storage error).');
    tokenInput.focus();
  }
  if (tokenRemove) tokenRemove.addEventListener('click', doRemoveToken);
  // Reset = 3 wheel-clicks on the ☑ box (gap up to 800 ms, touchpad-friendly).
  if (tokenCheck) {
    let wN = 0, wT = 0;
    tokenCheck.addEventListener('auxclick', async (e) => {
      if (e.button !== 1) return;     // 1 = middle/wheel
      e.preventDefault();
      const now = Date.now();
      wN = (now - wT <= 800) ? wN + 1 : 1;
      wT = now;
      if (wN >= 3) { wN = 0; doRemoveToken(); }
    });
    tokenCheck.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  }

  // ---- Hints on/off (per Lichess tab) ----
  // Shows the real state of the active tab's HUD; with no Lichess tab the
  // button is disabled and the status says so.
  let hintsOn = true;
  function setHintsBtn(on) {
    hintsOn = on;
    hintsToggle.textContent = on ? 'Hints on' : 'Hints off';
    hintsToggle.className   = on ? 'btn btn-start' : 'btn btn-stop';
    hintsToggle.title = on ? 'Click to hide hints in this tab' : 'Click to show hints in this tab';
  }
  const hud = await sendToTab({ type: 'HUD_GET' });
  if (!hud || !hud.ok) {
    setHintsBtn(true);
    hintsToggle.disabled = true;
    if (!statusLine || statusLine.style.display === 'none') showStatus('Open a Lichess game to use hints');
  } else {
    setHintsBtn(!hud.paused);
  }
  hintsToggle.onclick = async () => {
    const r = await sendToTab({ type: hintsOn ? 'HINT_HIDE' : 'HINT_SHOW' });
    if (!r || !r.ok) { showStatus('Open a Lichess game to use hints'); return; }
    setHintsBtn(!r.paused);
  };

  // ---- Data settings ----
  function openDataSettings(e) {
    if (e) e.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL('consent.html') }).catch(() => {});
    window.close();
  }
  if (dataSettings) dataSettings.addEventListener('click', openDataSettings);
  if (consentNeeded) consentNeeded.addEventListener('click', openDataSettings);
  try {
    const c = await browser.runtime.sendMessage({ type: 'CONSENT_GET' });
    if (consentNeeded) consentNeeded.style.display = (c && (c.state === 'granted' || c.state === 'denied')) ? 'none' : '';
  } catch (_) {
    if (consentNeeded) consentNeeded.style.display = '';
  }

  // MASTER MODE EASTER EGG (hidden trainer view)
  // KEEP THIS BLOCK. In release it stays hidden — there is no visible
  // control. Normal HUD shows "Rook d2►" (piece + start square, target
  // hidden). Master mode shows the FULL move ("Rook d2-d4") for self-
  // checking. Toggle by clicking the logo:
  // - 8 LEFT clicks → Master mode ON
  // - 3 WHEEL clicks → Master mode OFF (also a safe accidental reset)
  // Click series must be quick: gap up to 800 ms (touchpad-friendly);
  // a longer pause resets the counter so stray clicks do nothing.
  const gmLogo = document.getElementById('gm-logo');
  const CLICK_GAP_MS = 800;     // max pause between clicks in a series
  const LEFT_NEEDED  = 8;       // left clicks to turn Master mode ON
  const WHEEL_NEEDED = 3;       // wheel clicks to turn it OFF

  async function setMaster(on) {
    await apply({ masterMode: on });
    await sendToTab({ type: 'SET_MASTER', on });
  }
  // Flash a short message in the subtitle, then restore the version label.
  function flashSubtitle(text) {
    if (!gmSubtitle) return;
    gmSubtitle.textContent = text;
    setTimeout(() => { gmSubtitle.textContent = SUBTITLE; }, 1400);
  }

  if (gmLogo) {
    let leftN = 0, leftT = 0, wheelN = 0, wheelT = 0;

    gmLogo.addEventListener('click', () => {
      const now = Date.now();
      leftN = (now - leftT <= CLICK_GAP_MS) ? leftN + 1 : 1;
      leftT = now;
      if (leftN >= LEFT_NEEDED) {
        leftN = 0;
        setMaster(true);
        flashSubtitle('Master mode ON');
      }
    });

    // Wheel (middle) click → reset OFF. auxclick fires for non-primary buttons.
    gmLogo.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;   // 1 = middle/wheel
      e.preventDefault();
      const now = Date.now();
      wheelN = (now - wheelT <= CLICK_GAP_MS) ? wheelN + 1 : 1;
      wheelT = now;
      if (wheelN >= WHEEL_NEEDED) {
        wheelN = 0;
        setMaster(false);
        flashSubtitle('Master mode OFF');
      }
    });
    // Block the middle-click autoscroll bubble so the series is clean.
    gmLogo.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  }
  // end MASTER MODE EASTER EGG

  // ---- News plate ----
  // Shown when there is an unread item; independent of game access. Text
  // only; the link is checked again here before opening (https, allowed host).
  const newsPlate = document.getElementById('news-plate');
  const newsText  = document.getElementById('news-text');
  const newsClose = document.getElementById('news-close');
  try {
    const r = await browser.runtime.sendMessage({ type: 'GET_NEWS' });
    const news = validateNews(r && r.news);
    if (news) {
      newsText.textContent = news.title;
      newsPlate.style.display = 'flex';
      const url = safeNewsUrl(news.url);
      if (url) {
        newsPlate.onclick = (e) => {
          if (e.target === newsClose) return;
          browser.tabs.create({ url }).catch(() => {});
        };
      } else {
        newsPlate.style.cursor = 'default';
      }
      newsClose.onclick = async (e) => {
        e.stopPropagation();
        let ok = false;
        try { ok = !!(await browser.runtime.sendMessage({ type: 'DISMISS_NEWS', id: news.id }) || {}).ok; } catch (_) {}
        if (ok) newsPlate.style.display = 'none';
        else showStatus('Could not dismiss the news: extension storage unavailable');
      };
    }
  } catch(_) {}
});
