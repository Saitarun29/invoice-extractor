// Invoice Extractor · client
import { FIELDS, CONF_FLOOR, normalizeInvoice, analyze, labelOf, toCSV, minConfidence } from './core.js';
import { SAMPLES } from './samples.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RUN_TIMEOUT_MS = 40000;
const MAX_FILE = 3 * 1024 * 1024;
const MAX_TEXT = 20000;
const LS = { history: 'ie.history', queue: 'ie.queue', approved: 'ie.approved' };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const ICON = {
  ok: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  skip: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  x: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

// ---------- state ----------
let current = SAMPLES[0];
let inputMode = 'text';
let file = null;
let running = false;
let serverMode = 'demo';
let last = null;
let openId = null;
let confirmId = null;
let history = store.get(LS.history, []);
let queue = store.get(LS.queue, []);
let approved = store.get(LS.approved, []);
const save = () => { store.set(LS.history, history.slice(-200)); store.set(LS.queue, queue); store.set(LS.approved, approved.slice(-500)); };
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- formatting ----------
const fmtMoney = (n, cur) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = Number(n).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${cur} ${s}` : s;
};
const fmtConf = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtBytes = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const confHTML = (v, human) => {
  if (typeof v !== 'number') return '<span class="null">—</span>';
  const cls = human ? 'human' : v < CONF_FLOOR ? 'low' : '';
  return `<div class="conf ${cls}" title="${human ? 'Edited by a reviewer' : 'Model confidence'}"><span class="bar"><i style="width:${Math.round(v * 100)}%"></i></span>${fmtConf(v)}</div>`;
};

// ---------- presets ----------
const editor = $('#editor');
function renderPresets() {
  $('#presets').innerHTML = SAMPLES.map((p) => `
    <button type="button" class="preset" role="radio" aria-checked="${p.id === current.id}" data-id="${p.id}" tabindex="${p.id === current.id || (current.id === 'custom' && p === SAMPLES[0]) ? 0 : -1}">
      <span class="dot ${p.tone}" aria-hidden="true"></span>
      <b>${esc(p.label)}</b>
      <small>${esc(p.expect)}</small>
    </button>`).join('');
}
function loadPreset(p) {
  current = p;
  setInputMode('text');
  editor.value = p.text;
  updateCount();
  renderPresets();
  note(p.note);
}
function note(msg) { const n = $('#presetNote'); n.hidden = !msg; n.textContent = msg || ''; }
function updateCount() {
  const n = editor.value.length;
  const el = $('#charCount');
  el.textContent = `${n.toLocaleString('en-US')} / ${MAX_TEXT.toLocaleString('en-US')}`;
  el.className = 'json-state ' + (n > MAX_TEXT * 0.95 ? 'bad' : 'ok');
}
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('.preset');
  if (!b || running) return;
  loadPreset(SAMPLES.find((p) => p.id === b.dataset.id));
});
$('#presets').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const i = Math.max(0, SAMPLES.findIndex((p) => p.id === current.id));
  const n = SAMPLES[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : SAMPLES.length - 1)) % SAMPLES.length];
  loadPreset(n);
  $(`.preset[data-id="${n.id}"]`).focus();
});
editor.addEventListener('input', () => {
  updateCount();
  if (current.id !== 'custom') { current = { id: 'custom' }; renderPresets(); note(''); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.target.closest('.q-body')) { e.preventDefault(); run(); }
});

// ---------- tabs (shared keyboard behaviour) ----------
function wireTabs(list, onSelect) {
  const tabs = $$('[role="tab"]', list);
  const select = (t, focus) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      $('#' + x.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) t.focus();
    onSelect?.(t);
  };
  list.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      select(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
    }
  });
  return select;
}
const selectInput = wireTabs($('.seg'), (t) => { inputMode = t.id === 'tabFile' ? 'file' : 'text'; if (inputMode === 'file') note(''); });
const setInputMode = (m) => selectInput(m === 'file' ? $('#tabFile') : $('#tabText'));
const selectView = wireTabs($('.tabs'));

// ---------- file upload ----------
const drop = $('#drop');
function setFile(f) {
  showError('');
  if (!f) { file = null; drop.classList.remove('has-file'); $('#dropText').innerHTML = '<b>Choose a file</b> or drop it here'; return; }
  if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { showError('Upload a PDF, PNG, JPEG or WebP file.'); return; }
  if (f.size > MAX_FILE) { showError(`That file is ${fmtBytes(f.size)}. The limit is 3 MB.`); return; }
  file = f;
  drop.classList.add('has-file');
  $('#dropText').innerHTML = `<b>${esc(f.name)}</b> · ${fmtBytes(f.size)}`;
}
$('#fileInput').addEventListener('change', (e) => setFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
drop.tabIndex = 0;
drop.setAttribute('role', 'button');
drop.setAttribute('aria-describedby', 'fileHelp');
const toBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.readAsDataURL(f);
});

$('#clearBtn').addEventListener('click', () => {
  editor.value = ''; updateCount(); setFile(null); $('#fileInput').value = '';
  current = { id: 'custom' }; renderPresets(); note(''); showError('');
  editor.focus();
});

// ---------- mode badge ----------
async function loadStatus() {
  const b = $('#modeBadge');
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    const j = await r.json();
    serverMode = j.mode;
  } catch { serverMode = 'demo'; }
  b.textContent = serverMode === 'live' ? 'Live · Gemini 2.0 Flash' : 'Demo mode';
  b.className = 'badge ' + (serverMode === 'live' ? 'ok' : '');
  b.title = serverMode === 'live' ? 'Extraction runs on Gemini 2.0 Flash' : 'No API key configured: a rule-based parser returns the same JSON contract';
  if (serverMode !== 'live') $('#fileHelp').textContent = 'Demo mode: uploads need a Gemini key on the server. Paste text or use a sample instead.';
}

// ---------- run ----------
function showError(msg) { const b = $('#errorBox'); b.hidden = !msg; b.textContent = msg || ''; }
function setState(s) {
  $('#resultEmpty').hidden = s !== 'empty';
  $('#resultLoading').hidden = s !== 'loading';
  $('#result').hidden = s !== 'result';
}

async function run() {
  if (running) return;
  showError('');
  let body;
  if (inputMode === 'file') {
    if (!file) { showError('Choose a file first.'); return; }
    try { body = { file: { name: file.name, mime: file.type, data: await toBase64(file) } }; } catch (e) { showError(e.message); return; }
  } else {
    const text = editor.value.trim();
    if (!text) { showError('Paste invoice text or pick a sample.'); editor.focus(); return; }
    body = { text };
  }
  body.history = history;

  running = true;
  const btn = $('#runBtn');
  btn.disabled = true; btn.setAttribute('aria-busy', 'true'); $('.btn-label', btn).textContent = 'Extracting…';
  $('#resMeta').textContent = 'Working';
  setState('loading');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    const r = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    let data = null;
    try { data = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok) throw new Error(data?.error || `Request failed (${r.status}).`);
    accept(data, inputMode === 'file' ? file.name : current.id === 'custom' ? 'Pasted text' : current.label);
  } catch (e) {
    setState(last ? 'result' : 'empty');
    $('#resMeta').textContent = last ? $('#resMeta').textContent : 'Idle';
    showError(e.name === 'AbortError' ? 'The extraction took too long. Try again or paste a shorter document.' : e.message);
  } finally {
    clearTimeout(timer);
    running = false;
    btn.disabled = false; btn.removeAttribute('aria-busy'); $('.btn-label', btn).textContent = 'Extract';
  }
}
$('#runBtn').addEventListener('click', run);

function accept(data, sourceLabel) {
  const entry = {
    id: uid(), ts: Date.now(), source: sourceLabel, mode: data.mode,
    invoice: data.invoice, confidence: data.confidence, model_confidence: { ...data.confidence },
    flags: data.flags || [], checks: data.checks, routing: data.routing,
    history_before: history.slice(), edited: [],
  };
  if (data.dup_key) history.push(data.dup_key);
  if (data.routing.decision === 'auto_approve') {
    approved.push({ ...slim(entry), approved_at: new Date().toISOString(), route: 'auto' });
  } else {
    queue.unshift(entry);
    openId = entry.id;
  }
  save();
  last = data;
  renderResult(data);
  renderQueue();
  renderApproved();
}
const slim = (e) => ({ id: e.id, ts: e.ts, source: e.source, invoice: e.invoice, min_confidence: minConfidence(e.confidence).value });

// ---------- result ----------
function renderResult(d) {
  setState('result');
  const inv = d.invoice;
  const auto = d.routing.decision === 'auto_approve';
  const passed = d.checks.filter((c) => c.status === 'pass').length;
  const failed = d.checks.filter((c) => c.status === 'fail').length;
  $('#resMeta').textContent = `${d.mode === 'live' ? 'Live' : 'Demo'} · ${d.ms} ms`;
  $('#stats').innerHTML = [
    ['Vendor', inv.vendor || '—', inv.invoice_number ? `No. ${inv.invoice_number}` : 'No invoice number'],
    ['Total', fmtMoney(inv.total, inv.currency), inv.tax_total !== null ? `Tax ${fmtMoney(inv.tax_total)}` : 'No tax lines'],
    ['Min confidence', fmtConf(d.routing.min_confidence), d.routing.min_field ? labelOf(d.routing.min_field) : '—'],
    ['Checks', `${passed} / ${d.checks.length}`, failed ? `${failed} failed` : `${d.checks.length - passed} skipped`],
  ].map(([k, v, s]) => `<div class="stat"><small>${k}</small><b title="${esc(v)}">${esc(v)}</b><span>${esc(s)}</span></div>`).join('');

  $('#routeBox').innerHTML = (auto
    ? `<div class="route ok"><b>Auto-approved</b>All checks passed and every field is at or above ${CONF_FLOOR.toFixed(2)}. Added to approved rows.</div>`
    : `<div class="route warn"><b>Sent to the review queue</b><ul>${d.routing.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`)
    + (d.flags.length ? `<div class="flags"><b>Reviewer notes</b><ul>${d.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '')
    + (d.note ? `<div class="flags">${esc(d.note)}</div>` : '');

  $('#vFields').innerHTML = fieldsHTML(inv, d.confidence);
  $('#vChecks').innerHTML = `<ul class="checks">${checksHTML(d.checks)}</ul>`;
  $('#jsonOut').textContent = JSON.stringify({ invoice: d.invoice, confidence: d.confidence, checks: d.checks.map(({ id, status, detail }) => ({ id, status, detail })), routing: { decision: d.routing.decision, min_confidence: d.routing.min_confidence, reasons: d.routing.reasons }, flags: d.flags, mode: d.mode, model: d.model }, null, 2);
  selectView(failed ? $('#vtChecks') : $('#vtFields'));
}

function fieldsHTML(inv, conf, human = []) {
  const val = (f) => {
    const v = inv[f.key];
    if (v === null || v === undefined || v === '') return '<span class="null">not found</span>';
    return esc(f.type === 'money' ? fmtMoney(v, inv.currency) : v);
  };
  const rows = FIELDS.map((f) => `<tr><th scope="row">${esc(f.label)}</th><td>${val(f)}</td><td class="cf">${confHTML(conf[f.key], human.includes(f.key))}</td></tr>`).join('');
  const items = inv.line_items || [];
  const itemsTable = items.length ? `
    <div class="scroll-x"><table class="mini">
      <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
      <tbody>${items.map((li) => `<tr><td>${esc(li.description)}</td><td class="r">${li.quantity ?? '—'}</td><td class="r">${fmtMoney(li.unit_price)}</td><td class="r">${fmtMoney(li.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Sum of lines</td><td class="r">${fmtMoney(items.reduce((s, li) => s + (li.amount || 0), 0))}</td></tr></tfoot>
    </table></div>` : '<p class="small">No line items found.</p>';
  const tl = inv.tax_lines || [];
  const taxTable = tl.length ? `
    <div class="scroll-x"><table class="mini">
      <thead><tr><th>Tax</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>${tl.map((t) => `<tr><td>${esc(t.label)}</td><td class="r">${t.rate !== null ? t.rate + '%' : '—'}</td><td class="r">${fmtMoney(t.amount)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="small">No itemised tax.</p>';
  return `
    <div class="sec"><table class="kv"><tbody>${rows}</tbody></table></div>
    <div class="sec"><h3>Line items ${confHTML(conf.line_items, human.includes('line_items')).replace('class="conf', 'style="width:110px" class="conf')}</h3>${itemsTable}</div>
    <div class="sec"><h3>Tax breakdown ${confHTML(conf.tax_lines, human.includes('tax_lines')).replace('class="conf', 'style="width:110px" class="conf')}</h3>${taxTable}</div>`;
}

const ST = { pass: 'Pass', fail: 'Fail', skip: 'Skipped' };
function checksHTML(checks) {
  return checks.map((c) => `<li class="${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'no' : 'skip'}">${c.status === 'pass' ? ICON.ok : c.status === 'fail' ? ICON.no : ICON.skip}<div class="chk"><b>${esc(c.label)}</b><em>${esc(c.detail)}</em></div><span>${ST[c.status]}</span></li>`).join('');
}

$('#copyBtn').addEventListener('click', async () => {
  const b = $('#copyBtn');
  try { await navigator.clipboard.writeText($('#jsonOut').textContent); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; }
  setTimeout(() => { b.textContent = 'Copy JSON'; }, 1400);
});

// ---------- review queue ----------
function renderQueue() {
  const n = queue.length;
  $('#qCount').textContent = n;
  $('#qCount').className = 'count' + (n ? ' on' : '');
  $('#queueEmpty').hidden = n > 0;
  $('#queue').innerHTML = queue.map((e) => {
    const inv = e.invoice;
    const fails = e.checks.filter((c) => c.status === 'fail').length;
    const low = e.routing.low_confidence.length;
    const why = [fails ? `${fails} check${fails > 1 ? 's' : ''} failed` : '', low ? `${low} low-confidence field${low > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || 'Ready to approve';
    const open = e.id === openId;
    return `<li class="q" data-id="${e.id}">
      <div class="q-sum">
        <div><b>${esc(inv.vendor || 'Unknown vendor')}</b> <span class="small">${esc(inv.invoice_number || '')}</span><small>${esc(e.source)} · ${fmtTime(e.ts)} · ${esc(why)}</small></div>
        <span class="q-total">${fmtMoney(inv.total, inv.currency)}</span>
        <button type="button" class="btn btn-sm" data-act="toggle" aria-expanded="${open}" aria-controls="qb-${e.id}">${open ? 'Close' : 'Review'}</button>
      </div>
      ${open ? `<div class="q-body" id="qb-${e.id}">${editorHTML(e)}</div>` : ''}
    </li>`;
  }).join('');
}

function editorHTML(e) {
  const inv = e.invoice;
  const chip = (k) => {
    const v = e.confidence[k];
    if (e.edited.includes(k)) return '<span class="chip human">edited</span>';
    return typeof v === 'number' ? `<span class="chip ${v < CONF_FLOOR ? 'low' : ''}">${fmtConf(v)}</span>` : '';
  };
  const lowCls = (k) => (!e.edited.includes(k) && typeof e.confidence[k] === 'number' && e.confidence[k] < CONF_FLOOR ? ' low' : '');
  const fields = FIELDS.filter((f) => f.key !== 'tax_total').map((f) => {
    const v = inv[f.key] ?? '';
    const type = f.type === 'date' ? 'date' : 'text';
    const mode = f.type === 'money' ? ' inputmode="decimal"' : '';
    return `<div class="fld"><div class="fld-top"><label for="f-${e.id}-${f.key}">${esc(f.label)}${f.required ? '' : ' <span class="null">optional</span>'}</label>${chip(f.key)}</div>
      <input class="in${f.type === 'money' ? ' num' : ''}${lowCls(f.key)}" id="f-${e.id}-${f.key}" data-k="${f.key}" type="${type}" value="${esc(v)}"${mode} autocomplete="off" /></div>`;
  }).join('');
  const items = (inv.line_items || []).map((li, i) => `<tr data-i="${i}">
      <td><input class="in" data-li="description" value="${esc(li.description)}" aria-label="Line ${i + 1} description" /></td>
      <td class="c-q"><input class="in num" data-li="quantity" value="${li.quantity ?? ''}" inputmode="decimal" aria-label="Line ${i + 1} quantity" /></td>
      <td class="c-m"><input class="in num" data-li="unit_price" value="${li.unit_price ?? ''}" inputmode="decimal" aria-label="Line ${i + 1} unit price" /></td>
      <td class="c-m"><input class="in num" data-li="amount" value="${li.amount ?? ''}" inputmode="decimal" aria-label="Line ${i + 1} amount" /></td>
      <td><button type="button" class="icon-btn" data-act="del-line" aria-label="Remove line ${i + 1}">${ICON.x}</button></td></tr>`).join('');
  const taxes = (inv.tax_lines || []).map((t, i) => `<tr data-t="${i}">
      <td class="c-l"><input class="in" data-tl="label" value="${esc(t.label)}" aria-label="Tax ${i + 1} label" /></td>
      <td class="c-q"><input class="in num" data-tl="rate" value="${t.rate ?? ''}" inputmode="decimal" aria-label="Tax ${i + 1} rate percent" /></td>
      <td class="c-m"><input class="in num" data-tl="amount" value="${t.amount ?? ''}" inputmode="decimal" aria-label="Tax ${i + 1} amount" /></td>
      <td></td>
      <td><button type="button" class="icon-btn" data-act="del-tax" aria-label="Remove tax line ${i + 1}">${ICON.x}</button></td></tr>`).join('');
  return `
    ${e.flags.length ? `<div class="flags" style="margin:12px 0 0"><b>Reviewer notes</b><ul>${e.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    <div><h3>Fields</h3><div class="form-grid">${fields}</div></div>
    <div><h3>Line items ${chip('line_items')}</h3>
      <div class="scroll-x"><table class="edit-table"><thead><tr><th>Description</th><th class="c-q">Qty</th><th class="c-m">Unit price</th><th class="c-m">Amount</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>${items}</tbody></table></div>
      <button type="button" class="btn btn-sm" data-act="add-line">Add line</button></div>
    <div><h3>Tax lines ${chip('tax_lines')}</h3>
      <div class="scroll-x"><table class="edit-table"><thead><tr><th class="c-l">Label</th><th class="c-q">Rate %</th><th class="c-m">Amount</th><th></th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>${taxes}</tbody></table></div>
      <button type="button" class="btn btn-sm" data-act="add-tax">Add tax line</button></div>
    <div><h3>Checks</h3><ul class="checks q-checks" aria-live="polite">${checksHTML(e.checks)}</ul></div>
    <div class="q-foot">${footHTML(e)}</div>`;
}

function footHTML(e) {
  const fails = e.checks.filter((c) => c.status === 'fail').length;
  const lowLeft = e.routing.low_confidence.length;
  const status = fails ? `${fails} check${fails > 1 ? 's' : ''} still failing` : lowLeft ? `All checks pass · ${lowLeft} field${lowLeft > 1 ? 's' : ''} not yet confirmed` : 'All checks pass';
  const approve = confirmId === e.id
    ? `<span class="hint">Approve with ${fails} failing check${fails > 1 ? 's' : ''}?</span><button type="button" class="btn btn-sm btn-warn" data-act="approve-force">Yes, approve</button><button type="button" class="btn btn-sm" data-act="cancel">Cancel</button>`
    : `<button type="button" class="btn btn-sm btn-danger" data-act="reject">Reject</button><button type="button" class="btn btn-sm btn-primary" data-act="approve">${fails ? 'Approve with exceptions' : 'Approve'}</button>`;
  return `<span class="left">${esc(status)}</span><div class="right">${approve}</div>`;
}

const parseNum = (v) => { const s = String(v).trim(); return s === '' ? null : s; };
function readForm(li, e) {
  const raw = { ...e.invoice };
  $$('input[data-k]', li).forEach((inp) => { raw[inp.dataset.k] = inp.value.trim() || null; });
  raw.line_items = $$('tr[data-i]', li).map((tr) => ({
    description: $('[data-li="description"]', tr).value,
    quantity: parseNum($('[data-li="quantity"]', tr).value),
    unit_price: parseNum($('[data-li="unit_price"]', tr).value),
    amount: parseNum($('[data-li="amount"]', tr).value),
  }));
  raw.tax_lines = $$('tr[data-t]', li).map((tr) => ({
    label: $('[data-tl="label"]', tr).value,
    rate: parseNum($('[data-tl="rate"]', tr).value),
    amount: parseNum($('[data-tl="amount"]', tr).value),
  }));
  raw.tax_total = null; // recomputed from tax lines
  return raw;
}

function revalidate(e, li) {
  e.invoice = normalizeInvoice(readForm(li, e));
  if (!(e.invoice.tax_lines || []).length) e.invoice.tax_total = null;
  for (const k of e.edited) e.confidence[k] = 1;
  e.confidence.tax_total = e.edited.includes('tax_lines') ? 1 : e.confidence.tax_total;
  const r = analyze(e.invoice, e.confidence, { history: e.history_before });
  e.checks = r.checks; e.routing = r.routing; e.dup_key = r.dup_key;
}

$('#queue').addEventListener('input', (ev) => {
  const li = ev.target.closest('.q');
  const e = queue.find((x) => x.id === li?.dataset.id);
  if (!e) return;
  const t = ev.target;
  const key = t.dataset.k || (t.dataset.li ? 'line_items' : t.dataset.tl ? 'tax_lines' : null);
  if (key && !e.edited.includes(key)) {
    e.edited.push(key);
    const chipEl = t.closest('.fld')?.querySelector('.chip') || t.closest('div')?.querySelector('h3 .chip');
    if (chipEl) { chipEl.className = 'chip human'; chipEl.textContent = 'edited'; }
    t.classList.remove('low');
  }
  revalidate(e, li);
  confirmId = null;
  $('.q-checks', li).innerHTML = checksHTML(e.checks);
  $('.q-foot', li).innerHTML = footHTML(e);
  save();
});

$('#queue').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const li = b.closest('.q');
  const e = queue.find((x) => x.id === li.dataset.id);
  if (!e) return;
  const act = b.dataset.act;
  const focusSel = (sel) => requestAnimationFrame(() => { const n = $(`.q[data-id="${e.id}"] ${sel}`); n?.focus(); });
  if (act === 'toggle') { openId = openId === e.id ? null : e.id; confirmId = null; renderQueue(); focusSel('[data-act="toggle"]'); return; }
  if (act === 'add-line' || act === 'del-line' || act === 'add-tax' || act === 'del-tax') {
    e.invoice = normalizeInvoice(readForm(li, e));
    if (act === 'add-line') e.invoice.line_items.push({ description: 'New item', quantity: 1, unit_price: 0, amount: 0 });
    if (act === 'del-line') e.invoice.line_items.splice(Number(b.closest('tr').dataset.i), 1);
    if (act === 'add-tax') e.invoice.tax_lines.push({ label: 'Tax', rate: null, amount: 0 });
    if (act === 'del-tax') e.invoice.tax_lines.splice(Number(b.closest('tr').dataset.t), 1);
    const k = act.endsWith('line') ? 'line_items' : 'tax_lines';
    if (!e.edited.includes(k)) e.edited.push(k);
    e.invoice.tax_total = e.invoice.tax_lines.length ? Math.round(e.invoice.tax_lines.reduce((s, t) => s + (t.amount || 0), 0) * 100) / 100 : null;
    for (const kk of e.edited) e.confidence[kk] = 1;
    const r = analyze(e.invoice, e.confidence, { history: e.history_before });
    e.checks = r.checks; e.routing = r.routing;
    save(); renderQueue();
    focusSel(act.startsWith('add') ? (k === 'line_items' ? 'tr[data-i]:last-child input' : 'tr[data-t]:last-child input') : `[data-act="${act.startsWith('del-line') ? 'add-line' : 'add-tax'}"]`);
    return;
  }
  if (act === 'approve' && e.checks.some((c) => c.status === 'fail')) { confirmId = e.id; $('.q-foot', li).innerHTML = footHTML(e); focusSel('[data-act="approve-force"]'); return; }
  if (act === 'cancel') { confirmId = null; $('.q-foot', li).innerHTML = footHTML(e); focusSel('[data-act="approve"]'); return; }
  if (act === 'approve' || act === 'approve-force') {
    approved.push({ ...slim(e), approved_at: new Date().toISOString(), route: act === 'approve-force' ? 'human (exceptions)' : 'human' });
    if (e.dup_key && !history.includes(e.dup_key)) history.push(e.dup_key);
  }
  if (act === 'approve' || act === 'approve-force' || act === 'reject') {
    queue = queue.filter((x) => x.id !== e.id);
    if (openId === e.id) openId = null;
    confirmId = null;
    save(); renderQueue(); renderApproved();
    note(act === 'reject' ? `Rejected ${e.invoice.invoice_number || 'invoice'} from ${e.invoice.vendor || 'unknown vendor'}.` : `Approved ${e.invoice.invoice_number || 'invoice'}. It is in the approved table and the CSV export.`);
  }
});

// ---------- approved ----------
function renderApproved() {
  const rows = approved.slice().reverse();
  $('#aCount').textContent = approved.length;
  $('#approvedEmpty').hidden = rows.length > 0;
  $('#approvedBody').innerHTML = rows.map((a) => {
    const inv = a.invoice;
    const tone = a.route === 'auto' ? 'ok' : a.route === 'human' ? '' : 'warn';
    return `<tr><td>${fmtTime(a.approved_at)}</td><td><span class="tag ${tone}">${esc(a.route === 'auto' ? 'Auto' : a.route === 'human' ? 'Human' : 'Human, exceptions')}</span></td>
      <td>${esc(inv.vendor || '—')}</td><td class="mono">${esc(inv.invoice_number || '—')}</td><td class="mono">${esc(inv.issue_date || '—')}</td>
      <td class="r">${fmtMoney(inv.tax_total, inv.currency)}</td><td class="r">${fmtMoney(inv.total, inv.currency)}</td><td class="r">${fmtConf(a.min_confidence)}</td></tr>`;
  }).join('');
  $('#exportBtn').disabled = !rows.length;
}
$('#exportBtn').addEventListener('click', () => {
  if (!approved.length) return;
  const blob = new Blob([toCSV(approved)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `approved-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
let resetArmed = false;
$('#resetBtn').addEventListener('click', () => {
  const b = $('#resetBtn');
  if (!resetArmed) { resetArmed = true; b.textContent = 'Click again to reset'; setTimeout(() => { resetArmed = false; b.textContent = 'Reset session'; }, 3000); return; }
  resetArmed = false; b.textContent = 'Reset session';
  history = []; queue = []; approved = []; openId = null; save();
  renderQueue(); renderApproved();
  note('Session reset: approved rows, review queue and duplicate history cleared.');
});

// ---------- init ----------
renderPresets();
loadPreset(SAMPLES[0]);
renderQueue();
renderApproved();
setState('empty');
loadStatus();
