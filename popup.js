// popup.js — GenMate Chess Assistant Lite v1

document.addEventListener('DOMContentLoaded', async () => {
  const tokenBlock    = document.getElementById('token-block');
  const tokenInput    = document.getElementById('token-input');
  const modeSelect    = document.getElementById('mode-select');
  const timedWrapper  = document.getElementById('timed-wrapper');
  const movetimeInput = document.getElementById('movetime-input');
  const showEval      = document.getElementById('show-eval');
  const engineToggle  = document.getElementById('engine-toggle');
  const flipBtn       = document.getElementById('flip-color-btn');
  const saveBtn       = document.getElementById('save-btn');

  // Send message to the active Lichess tab (content script)
  async function sendToTab(msg) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await browser.tabs.sendMessage(tab.id, msg);
    } catch(_) {}
  }

  // ---- Load saved settings ----
  const s = await browser.storage.sync.get(['token', 'mode', 'movetime', 'showEval']);

  if (s.token) {
    tokenBlock.style.display = 'none';
    tokenInput.value = s.token;
  }

  const mode = s.mode || 'infinite';
  modeSelect.value = mode;
  timedWrapper.classList.toggle('visible', mode === 'timed');
  movetimeInput.value = Math.round((s.movetime || 3000) / 1000);
  showEval.checked = s.showEval !== false;

  // ---- Mode select ----
  modeSelect.addEventListener('change', () => {
    timedWrapper.classList.toggle('visible', modeSelect.value === 'timed');
  });

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

  // ---- Flip analysis side ----
  // Use this when the plugin detects the wrong colour automatically
  flipBtn.onclick = async () => {
    await sendToTab({ type: 'FLIP_COLOR' });
    flipBtn.textContent = '\u2194 Swapped!';
    setTimeout(() => { flipBtn.textContent = '\u2194 Swap Analysis Side'; }, 1200);
  };

  // ---- Save settings ----
  saveBtn.onclick = async () => {
    const token      = tokenInput.value.trim() || s.token || '';
    const newMode    = modeSelect.value;
    const movetimeMs = Math.max(1000, (parseInt(movetimeInput.value) || 3) * 1000);

    await browser.storage.sync.set({
      token, mode: newMode, movetime: movetimeMs, showEval: showEval.checked,
    });

    await browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
    await sendToTab({ type: 'SETTINGS_CHANGED' });

    saveBtn.textContent      = '\u2713 Saved!';
    saveBtn.style.background = '#16a34a';
    setTimeout(() => window.close(), 700);
  };

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
