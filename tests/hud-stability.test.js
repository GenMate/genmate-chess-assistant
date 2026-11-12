'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContent, streamResponse, ev, flush } = require('./helpers/env');

async function result() {
  const streams = [];
  const e = loadContent({ url: 'https://lichess.org/game/abcdefgh',
    local: { token: 'lip_TESTTOKEN0000000000', multiPv: 2 },
    setup: env => {
      env.gamePage({});
      env.fetch.reply = () => { const s = streamResponse(); streams.push(s); return s; };
    } });
  await flush(20);
  streams[0].push(ev.full('abcdefgh')); await flush(10);
  const job = e.sent.filter(m => m.type === 'ENGINE_ANALYZE').at(-1);
  for (const line of ['info depth 28 multipv 1 score cp 80 pv g1f3', 'info depth 27 multipv 2 score cp -80 pv b1c3']) {
    e.toContent({ type: 'ENGINE_LINE', session: job.session, jobId: job.jobId, line });
  }
  return { e, streams, job };
}
const body = e => e.document.getElementById('gm-hud-body');

test('network failure preserves moves, scores and depth while footer changes', async () => {
  const { e, streams } = await result();
  const previous = body(e).textContent;
  assert.match(previous, /Knight/);
  assert.match(previous, /0.80/);
  streams[0].fail(); await flush(20);
  assert.equal(body(e).textContent, previous);
  assert.match(e.hudText(), /Depth: 28/);
  assert.match(e.hudText(), /Reconnecting/);
  assert.doesNotMatch(e.hudText(), /last result/);
  await e.clock.advance(600000);
  assert.equal(body(e).textContent, previous);
  assert.ok(e.hudVisible());
});

test('ordinary trusted clicks and selected text do not restart or clear analysis', async () => {
  const { e } = await result();
  const before = e.sent.filter(m => m.type === 'ENGINE_ANALYZE').length;
  const text = e.hudText();
  e.hud().dispatch('click');
  e.hud().dispatch('click', { target: body(e) });
  e.ctx.window.getSelection = () => 'Knight';
  e.hud().dispatch('click'); await flush();
  assert.equal(e.sent.filter(m => m.type === 'ENGINE_ANALYZE').length, before);
  assert.equal(e.hudText(), text);
});

test('same-game new position keeps the original move number and rows until a new result arrives', async () => {
  const { e, streams } = await result();
  const previous = body(e).textContent;
  streams[0].push(ev.state('g1f3')); await flush(10);
  assert.equal(body(e).textContent, previous);
  assert.doesNotMatch(e.hudText(), /last result/);
  assert.match(e.hudText(), /Opponent thinking/);
  streams[0].push(ev.state('g1f3 g8f6')); await flush(10);
  assert.equal(body(e).textContent, previous);
  const job = e.sent.filter(m => m.type === 'ENGINE_ANALYZE').at(-1);
  e.toContent({ type: 'ENGINE_LINE', session: job.session, jobId: job.jobId,
    line: 'info depth 12 score cp 20 pv b1c3' });
  assert.match(e.hudText(), /Depth: 12/);
  assert.doesNotMatch(e.hudText(), /last result/);
  assert.notEqual(body(e).textContent, previous);
});

test('changing games, consent or eligibility never shows an old-game hint as current', async () => {
  const { e } = await result();
  e.setUrl('https://lichess.org/game/ijklmnop');
  await e.clock.advance(1100);
  assert.equal(body(e).textContent, '');
  assert.doesNotMatch(e.hudText(), /Depth: 28/);
  const other = await result();
  other.e.consent = 'denied'; other.e.toContent({ type: 'CONSENT_CHANGED' }); await flush(20);
  assert.equal(body(other.e).textContent, '');
  assert.match(other.e.hudText(), /Allow game access/);
});

test('resize clamps the entire HUD and restores preferred dimensions without analysis messages', async () => {
  const { e } = await result();
  const previous = body(e).textContent;
  const count = e.sent.filter(m => m.type === 'ENGINE_ANALYZE').length;
  e.get('preferredRect = {left: 1500, top: 900, width: 450, height: 220}; layoutHud()');
  e.ctx.window.innerWidth = 360; e.ctx.window.innerHeight = 190;
  e.ctx.window.dispatch('resize');
  const h = e.hud().style;
  assert.ok(parseFloat(h.left) >= 0 && parseFloat(h.top) >= 0);
  assert.ok(parseFloat(h.left) + parseFloat(h.width) <= 360);
  assert.ok(parseFloat(h.top) + parseFloat(h.height) <= 190);
  e.ctx.window.innerWidth = 1920; e.ctx.window.innerHeight = 1080; e.ctx.window.dispatch('resize');
  assert.equal(h.width, '450px'); assert.equal(h.height, '220px');
  assert.equal(body(e).textContent, previous);
  assert.equal(e.sent.filter(m => m.type === 'ENGINE_ANALYZE').length, count);
});

test('geometry fits even a viewport smaller than the normal minimum', async () => {
  const { e } = await result();
  for (const [w, h] of [[1, 1], [160, 90], [330, 148], [800, 600]]) {
    const r = e.get(`fitHudRect({left: -900, top: 9999, width: 600, height: 400}, {width:${w}, height:${h}})`);
    assert.ok(r.left >= 0 && r.top >= 0);
    assert.ok(r.left + r.width <= w && r.top + r.height <= h);
  }
});

test('header drag and corner resize preserve hints; body mousedown is selectable', async () => {
  const { e } = await result();
  const text = body(e).textContent, count = e.sent.filter(m => m.type === 'ENGINE_ANALYZE').length;
  const header = e.document.getElementById('gm-hud-header');
  header.dispatch('mousedown', { clientX: 20, clientY: 20 });
  e.document.dispatch('mousemove', { clientX: -9000, clientY: -9000 });
  e.document.dispatch('mouseup');
  assert.equal(e.hud().style.left, '8px'); assert.equal(e.hud().style.top, '8px');
  e.document.getElementById('gm-resize').dispatch('mousedown', { clientX: 0, clientY: 0 });
  e.document.dispatch('mousemove', { clientX: 80, clientY: 70 });
  e.document.dispatch('mouseup');
  assert.equal(e.hud().style.width, '410px'); assert.equal(e.hud().style.height, '222px');
  let prevented = false;
  body(e).dispatch('mousedown', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(body(e).textContent, text);
  assert.equal(e.sent.filter(m => m.type === 'ENGINE_ANALYZE').length, count);
  assert.ok(e.get('sessionStorage.getItem(HUD_RECT_KEY)'));
});

test('brief round markup removal on the same game URL does not drop the live HUD', async () => {
  const { e } = await result();
  const previous = body(e).textContent;
  e.document.selectors['main.round'] = null;
  e.document.selectors['main cg-board'] = null;
  await e.clock.advance(1100);
  assert.ok(e.hudVisible());
  assert.equal(body(e).textContent, previous);
  assert.equal(e.streamCalls().length, 1);
  e.setUrl('https://lichess.org/analysis'); await e.clock.advance(1100);
  assert.equal(e.hudVisible(), false);
});

test('every font role scales with geometry, not with message contents', async () => {
  const { e } = await result();
  const name = e.document.getElementById('gm-hud-header');
  const before = parseFloat(name.style.fontSize);
  e.get('preferredRect.width = 600; preferredRect.height = 330; layoutHud()');
  assert.ok(parseFloat(name.style.fontSize) > before);
  const size = name.style.fontSize;
  e.get("setStatus(TXT_LOST, 'err', 'retry')");
  assert.equal(name.style.fontSize, size);
  assert.match(e.hudText(), /Depth: 28/);
});

test('approved header/status colors and compact footer are preserved with no extra labels', async () => {
  const { e } = await result();
  e.get("setStatus(TXT_OPP_TURN, 'wait')");
  assert.strictEqual(e.document.getElementById('gm-hud-status').textContent, 'Opponent thinking…');
  assert.strictEqual(e.document.getElementById('gm-hud-status').style.height, '36px');
  assert.strictEqual(e.get('CLR_GEAR'), '#60a5fa');
  assert.strictEqual(e.get('CLR_HDR'), '#94a3b8');
  assert.match(e.document.getElementById('gm-style').textContent, /background:#0c223b;color:#dde5ef/);
  assert.doesNotMatch(e.hudText(), /last result|[·•]/);
});

test('three selected PV lines reach the engine request and all render in the same HUD shell', async () => {
  const { e } = await result();
  await e.local.set({ multiPv: 3 }); await flush(20);
  const job = e.sent.filter(m => m.type === 'ENGINE_ANALYZE').at(-1);
  assert.strictEqual(job.multiPv, 3);
  for (const [i,move] of [[1,'g1f3'],[2,'b1c3'],[3,'e2e4']]) e.toContent({type:'ENGINE_LINE',session:job.session,jobId:job.jobId,line:'info depth 12 multipv '+i+' score cp 20 pv '+move});
  assert.strictEqual(body(e).querySelectorAll('tr').length, 3);
  assert.strictEqual(e.document.getElementById('gm-hud-status').style.height, '36px');
});

test('explicit line-count changes grow rows without shrinking the font or accumulating height', async () => {
  const {e}=await result();
  e.get('cfg.multiPv=1; preferredRect={left:8,top:8,width:340,height:120,lines:1}; layoutHud()');
  const font=body(e).style.fontSize;assert.strictEqual(font,'23px');
  for(const [lines,height] of [[2,152],[3,184],[1,120],[2,152]]){
    await e.local.set({multiPv:lines});await flush(20);
    assert.strictEqual(e.hud().style.height,height+'px');
    assert.strictEqual(body(e).style.fontSize,font);
    e.toContent({type:'SETTINGS_CHANGED'});await flush(20);
    assert.strictEqual(e.hud().style.height,height+'px');
  }
});

test('gear color remains saturated green for analysis, opponent turn and reconnection', async () => {
  const {e}=await result();
  for(const status of ["setStatus(TXT_ANALYZING,'wait')","session.an.running=false;setStatus(TXT_OPP_TURN,'wait')","setStatus(TXT_RECONNECTING,'wait')"]){
    e.get(status);assert.strictEqual(e.document.getElementById('gm-gear').style.color,'#22c55e');
  }
});

test('evaluation values are bold without equals; trainer promotion notation stays intact', async () => {
  const {e}=await result();
  const cells=body(e).querySelectorAll('td').filter(n=>n.className==='gm-evaluation');
  assert.strictEqual(cells.length,2);
  for(const cell of cells){assert.doesNotMatch(cell.textContent,/^=/);assert.match(cell.style.cssText,/font-weight:700/);}
  assert.strictEqual(e.get("fmtMove('7r/6P1/8/8/8/8/8/8 w - - 0 1','g7h8q')"),'g7xh8=Q');
});

test('evaluation off removes the empty score column without changing HUD width', async () => {
  const {e}=await result();
  await e.local.set({showEval:false});await flush(20);
  for(const row of body(e).querySelectorAll('tr'))assert.strictEqual(row.children.length,3);
  assert.strictEqual(e.hud().style.width,'330px');
});

test('legacy preview geometry keeps position and adopts the new 330px count layout', async () => {
  const {e}=await result();
  e.get("sessionStorage.setItem('gm_hint_rect_v2',JSON.stringify({left:100,top:80,width:450,height:220})); restorePos();layoutHud()");
  assert.strictEqual(e.hud().style.left,'100px');assert.strictEqual(e.hud().style.top,'80px');
  assert.strictEqual(e.hud().style.width,'330px');assert.strictEqual(e.hud().style.height,'152px');
});

test('line-count changes also preserve the font after a manual rectangle resize', async () => {
  const {e}=await result();
  e.get('preferredRect={left:8,top:8,width:340,height:140,lines:2};layoutHud()');
  const font=body(e).style.fontSize;
  for(const lines of [3,1,2]){await e.local.set({multiPv:lines});await flush(20);assert.strictEqual(body(e).style.fontSize,font);}
});


test('completed timed search keeps hints and depth with a blank stable footer', async () => {
  const { e, job } = await result();
  const before = body(e).textContent;
  const footer = e.document.getElementById('gm-hud-status');
  const height = footer.style.height;
  e.toContent({ type: 'ENGINE_LINE', session: job.session, jobId: job.jobId, line: 'bestmove g1f3' });
  await e.clock.advance(5000);
  assert.equal(body(e).textContent, before);
  assert.match(e.hudText(), /Depth: 28/);
  assert.equal(footer.textContent, '');
  assert.equal(footer.style.height, height);
  assert.equal(e.document.getElementById('gm-gear').style.color, '#22c55e');
});

test('completed search does not erase a genuine reconnecting message', async () => {
  const { e, job, streams } = await result();
  streams[0].fail(); await flush(20);
  e.toContent({ type: 'ENGINE_LINE', session: job.session, jobId: job.jobId, line: 'bestmove g1f3' });
  assert.match(e.hudText(), /Reconnecting/);
});
