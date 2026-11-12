// consent.js — GenMate Chess Assistant — data settings page
// Copyright (C) 2026 GenMate
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Uses common.js: DATA_COLLECTION, DISCLOSURE_VERSION.
//
// Firefox 140+ supports optional data collection permissions: "Allow" asks
// Firefox for them (permissions.request, called directly in the click handler)
// and Firefox keeps the grant. Older Firefox has no such API: the decision is
// stored locally by the background page. If support cannot be determined, the
// page stays fail-closed (no way to allow; nothing is sent to Lichess).

let support = 'unknown';   // 'modern' | 'legacy' | 'error'

const $ = id => document.getElementById(id);

function setMsg(id, text) { const e = $(id); if (e) e.textContent = text || ''; }

async function detectSupport() {
  try {
    const all = await browser.permissions.getAll();
    support = (all && typeof all === 'object' && 'data_collection' in all) ? 'modern' : 'legacy';
  } catch (_) {
    support = 'error';
  }
}

async function recordDecision(game) {
  const r = await browser.runtime.sendMessage({ type: 'CONSENT_SET', game });
  if (!r || !r.ok) throw new Error('storage');
}

const STATE_TEXT = {
  granted:   'Current choice: game access allowed. Live hints can work.',
  denied:    'Current choice: game access not allowed. Live hints are off.',
  undecided: 'Current choice: not decided yet. Live hints are off until you allow game access.',
  error:     'Could not read the current choice (browser or storage error). Nothing is sent to Lichess.',
};

async function refresh() {
  let state = 'error';
  try {
    const c = await browser.runtime.sendMessage({ type: 'CONSENT_GET' });
    if (c && typeof c.state === 'string' && STATE_TEXT[c.state]) state = c.state;
  } catch (_) { state = 'error'; }
  if (support === 'error') state = 'error';
  const st = $('state');
  st.textContent = STATE_TEXT[state];
  st.className = 'state ' + state;
  st.style.display = state === 'undecided' ? 'none' : '';
  const blocked = support !== 'modern' && support !== 'legacy';
  $('allow').disabled = blocked;
  $('deny').disabled = blocked;
  $('withdraw').style.display = state === 'granted' ? '' : 'none';
}

function onAllow() {
  setMsg('game-msg', '');
  if (support === 'modern') {
    // Must be the first call in the user's click: no await before it.
    let req;
    try { req = browser.permissions.request({ data_collection: DATA_COLLECTION }); }
    catch (_) { setMsg('game-msg', 'Firefox did not accept the request. Please try again.'); return; }
    req.then(async granted => {
      if (granted) await recordDecision(true).catch(() => {
        setMsg('game-msg', 'Could not save your choice (storage error). Please try again.');
      });
      else setMsg('game-msg', 'Firefox reports that game access was not allowed.');
      refresh();
    }, () => { setMsg('game-msg', 'Firefox did not accept the request. Please try again.'); refresh(); });
    return;
  }
  if (support === 'legacy') {
    recordDecision(true).then(refresh, () => {
      setMsg('game-msg', 'Could not save your choice (storage error). Nothing is sent to Lichess.');
      refresh();
    });
  }
}

async function onDeny() {
  setMsg('game-msg', '');
  if (support !== 'modern' && support !== 'legacy') return;
  try {
    if (support === 'modern') await browser.permissions.remove({ data_collection: DATA_COLLECTION });
    await recordDecision(false);
  } catch (_) {
    setMsg('game-msg', 'Could not save your choice completely (browser or storage error).');
  }
  refresh();
}

document.addEventListener('DOMContentLoaded', async () => {
  $('allow').addEventListener('click', onAllow);
  $('deny').addEventListener('click', onDeny);
  $('withdraw').addEventListener('click', onDeny);
  $('uninstall').addEventListener('click', () => {
    browser.management.uninstallSelf({ showConfirmDialog: true }).catch(() => {});
  });
  // Buttons stay disabled until support is known.
  $('allow').disabled = true; $('deny').disabled = true;
  await detectSupport();
  await refresh();
  if (browser.permissions.onAdded) browser.permissions.onAdded.addListener(refresh);
  if (browser.permissions.onRemoved) browser.permissions.onRemoved.addListener(refresh);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.consent) refresh();
  });
});
