// popup.js — GenMate Chess Assistant v1

// GENMATE: UI VISIBILITY FLAGS (keep)
// Flip to false to HIDE a block in the popup. The markup and logic
// STAY in code — only display is toggled. Set true to show again.
const SHOW_ENGINE_SELECTOR = true;   // Engine chooser (lite / full)
const SHOW_YOUTUBE         = false;  // YouTube link hidden in footer (markup kept for a future link)

// Engine label shown in the popup subtitle (must match background ENGINE_LABELS)
const ENGINE_LABELS = {
  lite: 'CHESS ASSISTANT · v1 — Stockfish 18 Lite',
  full: 'CHESS ASSISTANT · v1 — Stockfish 18 (full NNUE)',
};

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

document.addEventListener('DOMContentLoaded', async () => {
  const tokenBlock    = document.getElementById('token-block');
  const tokenInput    = document.getElementById('token-input');
  const modeSelect    = document.getElementById('mode-select');
  const pvSelect      = document.getElementById('pv-select');
  const movetimeInput = document.getElementById('movetime-input');
  const showEval      = document.getElementById('show-eval');
  const showFrom      = document.getElementById('show-from');
  const engineToggle  = document.getElementById('engine-toggle');
  const engineSelect  = document.getElementById('engine-select');
  const engineSection = document.getElementById('engine-section');
  const gmSubtitle    = document.getElementById('gm-subtitle');
  const tokenSave     = document.getElementById('token-save');
  const tokenCheck    = document.getElementById('token-check');
  const ytLink        = document.getElementById('yt-link');

  // Apply visibility flags (block stays in DOM; only display toggles)
  // Engine chooser: the "Full" engine is OFFERED ONLY when its files are truly
  // present in wasm/. This build ships Lite only, so the Full option must NOT
  // appear. A plain fetch(ok) is unreliable for a missing packaged file, so we
  // fetch the engine's .js and require real content (~20 KB). If it is absent,
  // we both hide the section AND remove the "full" <option> entirely.
  async function fullEnginePresent() {
    try {
      const r = await fetch(browser.runtime.getURL('wasm/stockfish-18-single.js'));
      if (!r.ok) return false;
      const t = await r.text();
      return t.length > 1000;   // real single.js is ~20 KB; missing/empty → false
    } catch(_) { return false; }
  }
  const engineFullOpt = engineSelect ? engineSelect.querySelector('option[value="full"]') : null;
  if (engineSection) engineSection.style.display = 'none';   // hidden by default
  if (engineSection && SHOW_ENGINE_SELECTOR) {
    fullEnginePresent().then(has => {
      if (has) {
        engineSection.style.display = '';                   // both engines available
      } else if (engineFullOpt) {
        engineFullOpt.remove();                             // never offer a missing engine
      }
    });
  }
  if (ytLink && !SHOW_YOUTUBE) ytLink.style.display = 'none';

  // Send message to the active Lichess tab (content script)
  async function sendToTab(msg) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await browser.tabs.sendMessage(tab.id, msg);
    } catch(_) {}
  }

  // Instant-apply: every option writes to storage and notifies the engine +
  // page immediately. There is NO Save button — changes take effect at once.
  async function apply(patch) {
    await browser.storage.sync.set(patch);
    await browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
    await sendToTab({ type: 'SETTINGS_CHANGED' });
  }

  // ---- Load saved settings ----
  const s = await browser.storage.sync.get(['token', 'mode', 'movetime', 'showEval', 'multiPv', 'engine', 'hintMode']);

  // ---- Token UI: one-time entry, collapse after save, ☑ indicator ----
  const BOX_EMPTY = '\u2610';   // ☐
  const BOX_TICK  = '\u2611';   // ☑
  function showTokenEntry() {
    tokenBlock.style.display = '';
    if (tokenCheck) tokenCheck.textContent = BOX_EMPTY;
  }
  function showTokenSaved() {
    tokenBlock.style.display = 'none';
    if (tokenCheck) tokenCheck.textContent = BOX_TICK;
  }
  if (s.token) { tokenInput.value = s.token; showTokenSaved(); }
  else         { showTokenEntry(); }

  // ---- Load + bind options (instant-apply) ----
  const mode = s.mode || 'infinite';
  modeSelect.value = mode;
  movetimeInput.style.display = (mode === 'timed') ? '' : 'none';
  movetimeInput.value = fmtSec(s.movetime || 3000);
  showEval.checked = s.showEval !== false;       // default ON
  showFrom.checked = (s.hintMode === 'origin');  // default OFF → piece type only
  pvSelect.value = String(s.multiPv || 1);

  // Mode: show the seconds field only in Timed mode; apply immediately.
  modeSelect.addEventListener('change', () => {
    const timed = modeSelect.value === 'timed';
    movetimeInput.style.display = timed ? '' : 'none';
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

  pvSelect.addEventListener('change', () => apply({ multiPv: parseInt(pvSelect.value) || 1 }));
  showEval.addEventListener('change', () => apply({ showEval: showEval.checked }));
  // From-square ON -> "Rook d2 ►"; OFF -> piece type only "Rook". Master overrides.
  showFrom.addEventListener('change', () => apply({ hintMode: showFrom.checked ? 'origin' : 'piece' }));

  // ---- Engine selector (engine name lives in the dropdown, not the subtitle) ----
  const engineChoice = (s.engine === 'lite' || s.engine === 'full') ? s.engine : 'lite';
  if (engineSelect) engineSelect.value = engineChoice;

  if (engineSelect) {
    engineSelect.addEventListener('change', async () => {
      const eng = engineSelect.value;
      // Hot-swap: background tears down the worker and boots the chosen engine.
      try { await browser.runtime.sendMessage({ type: 'ENGINE_SWITCH', engine: eng }); } catch(_) {}
      await sendToTab({ type: 'SETTINGS_CHANGED' });
    });
  }

  // ---- Token: one-time save + wheel-reset on the ☑ indicator ----
  if (tokenSave) {
    tokenSave.onclick = async () => {
      const t = tokenInput.value.trim();
      if (!t) return;
      await browser.storage.sync.set({ token: t });
      await browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
      await sendToTab({ type: 'SETTINGS_CHANGED' });
      showTokenSaved();
    };
  }
  // Reset = 3 wheel-clicks on the ☑ box (gap up to 800 ms, touchpad-friendly).
  if (tokenCheck) {
    let wN = 0, wT = 0;
    tokenCheck.addEventListener('auxclick', async (e) => {
      if (e.button !== 1) return;     // 1 = middle/wheel
      e.preventDefault();
      const now = Date.now();
      wN = (now - wT <= 800) ? wN + 1 : 1;
      wT = now;
      if (wN >= 3) {
        wN = 0;
        await browser.storage.sync.set({ token: '' });
        await browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
        await sendToTab({ type: 'SETTINGS_CHANGED' });
        tokenInput.value = '';
        showTokenEntry();
        tokenInput.focus();
      }
    });
    tokenCheck.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  }

  // ---- Engine toggle ----
  // Label shows what WILL HAPPEN on click (action-oriented UX):
  //   "⏹ Stop Engine"  — currently running → click stops it
  //   "▶ Start Engine" — currently stopped → click starts it
  let engineRunning = false;

  function setEngineBtn(running) {
    engineRunning = running;
    if (running) {
      engineToggle.textContent = '\u23F9 Stop Engine';
      engineToggle.className   = 'btn btn-stop';
    } else {
      engineToggle.textContent = '\u25B6 Start Engine';
      engineToggle.className   = 'btn btn-start';
    }
  }

  try {
    const status = await browser.runtime.sendMessage({ type: 'ENGINE_STATUS' });
    setEngineBtn(!!(status && status.ready));
  } catch(_) {
    setEngineBtn(false);
  }

  engineToggle.onclick = async () => {
    if (engineRunning) {
      await browser.runtime.sendMessage({ type: 'ENGINE_STOP' }).catch(() => {});
      await sendToTab({ type: 'HINT_HIDE' });
      setEngineBtn(false);
    } else {
      await browser.runtime.sendMessage({ type: 'ENGINE_REGISTER' }).catch(() => {});
      await sendToTab({ type: 'HINT_SHOW' });
      setEngineBtn(true);
    }
  };

  // MASTER MODE EASTER EGG (hidden trainer view)
  // KEEP THIS BLOCK. In release it stays hidden — there is no visible
  // control. Normal HUD shows "Rook d2►" (piece + start square, target
  // hidden). Master mode shows the FULL move ("Rook d2-d4") for self-
  // checking. Toggle by clicking the logo:
  // • 8 LEFT clicks → Master mode ON
  // • 3 WHEEL clicks → Master mode OFF (also a safe accidental reset)
  // Click series must be quick: gap up to 800 ms (touchpad-friendly);
  // a longer pause resets the counter so stray clicks do nothing.
  const gmLogo = document.getElementById('gm-logo');
  const CLICK_GAP_MS = 800;     // max pause between clicks in a series
  const LEFT_NEEDED  = 8;       // left clicks to turn Master mode ON
  const WHEEL_NEEDED = 3;       // wheel clicks to turn it OFF

  async function setMaster(on) {
    await browser.storage.sync.set({ masterMode: on });
    await sendToTab({ type: 'SET_MASTER', on });
  }
  // Flash a short message in the subtitle, then restore the engine label.
  function flashSubtitle(text) {
    if (!gmSubtitle) return;
    const restore = gmSubtitle.textContent;
    gmSubtitle.textContent = text;
    setTimeout(() => { gmSubtitle.textContent = restore; }, 1400);
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
  // Background stores an unread announcement in `pendingNews` (fetched from
  // GitHub news.json). We show it as a dismissible plate at the top of the popup.
  const newsPlate = document.getElementById('news-plate');
  const newsText  = document.getElementById('news-text');
  const newsClose = document.getElementById('news-close');
  try {
    const r = await browser.runtime.sendMessage({ type: 'GET_NEWS' });
    const news = r && r.pendingNews;
    if (news && news.title) {
      newsText.textContent = news.title;
      newsPlate.style.display = 'flex';
      if (news.url) {
        newsPlate.onclick = (e) => {
          if (e.target === newsClose) return;
          browser.tabs.create({ url: news.url });
        };
      }
      newsClose.onclick = async (e) => {
        e.stopPropagation();
        newsPlate.style.display = 'none';
        await browser.runtime.sendMessage({ type: 'DISMISS_NEWS' }).catch(() => {});
      };
    }
  } catch(_) {}
});
