// Zoomex Position Sizer — client UI. Validation here is for UX only; the server
// is authoritative. SIZE is the output, STOP is the input — there is no "size
// first" mode and no override button by design.

const $ = (id) => document.getElementById(id);

const fmt = {
  usd: (n) => (n == null || !isFinite(n)) ? '—' :
    (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(2) + '%',
  pct1: (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(1) + '%',
  rr: (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(2) + 'R',
  // Price: trim trailing-zero noise but keep precision (mirrors server fmtPrice).
  price: (n) => {
    if (n == null || !isFinite(n)) return '—';
    let s = Number(n).toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' ? '0' : s;
  },
  qty: (n) => {
    if (n == null || !isFinite(n)) return '—';
    if (Number.isInteger(n)) return String(n);
    return Number(n).toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  },
};

let knownSpecs = {};   // symbol -> spec, from /api/specs
let currentPlan = null;

const NEW_SYMBOL = '__new__'; // sentinel option that reveals the new-symbol field

// ---------- Boot ----------

(async function init() {
  await refreshPlan();
  knownSpecs = await (await fetch('/api/specs')).json();
  populateSymbols();
  bindBehavior();
  applySymbolSpecState();
})();

function bindBehavior() {
  // Attach first so numeric fields are sanitized before the ack-strip listeners
  // below read their values on each input event.
  attachNumericGuards();
  $('calcForm').addEventListener('submit', onCalculate);
  $('symbolSelect').addEventListener('change', applySymbolSpecState);
  $('newSymbol').addEventListener('input', applySymbolSpecState);
  $('amendBtn').addEventListener('click', openAmend);
  $('cancelAmendBtn').addEventListener('click', () => $('amendPanel').classList.add('hidden'));
  $('previewBtn').addEventListener('click', onPreview);
  $('saveSpecBtn').addEventListener('click', onSaveSpec);
  $('tradeAccount').addEventListener('input', renderAckLive);
  $('tradeRisk').addEventListener('input', renderAckLive);
  $('committedMargin').addEventListener('input', renderAckLive);
  $('resetPlanBtn').addEventListener('click', () => { seedTradeInputs(); renderAckLive(); });
}

// ---------- Numeric-input guards ----------
// Every field that takes a number (prices, account/risk, fees, contract specs) is
// a copy-paste target from the Zoomex GUI. Two goals for all of them:
//   1. Only a positive decimal is ever allowed in the box — no letters, no stray
//      symbols, no second decimal point.
//   2. A paste REPLACES the field instead of appending, so a fast double Ctrl+V
//      leaves one number, not "0.33790.3379". Because we preventDefault and rewrite
//      the whole value, the second paste just overwrites with the same number.
const NUMERIC_FIELDS = [
  'entry', 'stop', 'target',                                  // prices
  'tradeAccount', 'tradeRisk', 'committedMargin', 'takerFeePct', // per-trade
  'am-account', 'am-risk', 'am-lev',                          // plan amendment
  'sp-minQty', 'sp-qtyStep', 'sp-minNotional', 'sp-contractValue', // contract spec
];

// Keep digits and a SINGLE decimal point; drop everything else (later dots too).
function sanitizeDecimal(raw) {
  let s = String(raw).replace(/[^\d.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  }
  return s;
}

function attachNumericGuards() {
  NUMERIC_FIELDS.forEach((id) => {
    const el = $(id);
    if (!el) return;

    // Typing / drag-drop / autofill: strip anything that isn't part of a decimal,
    // preserving the caret position relative to the surviving characters.
    el.addEventListener('input', () => {
      const before = el.value;
      const clean = sanitizeDecimal(before);
      if (clean === before) return;
      const caret = el.selectionStart == null ? clean.length : el.selectionStart;
      const keptBeforeCaret = sanitizeDecimal(before.slice(0, caret)).length;
      el.value = clean;
      el.setSelectionRange(keptBeforeCaret, keptBeforeCaret);
    });

    // Paste: swallow the default and set the whole field to the sanitized clipboard
    // value. Replacing (not inserting) is what defeats the accidental double paste.
    // Re-dispatch 'input' so dependent listeners (e.g. the live ack strip) refresh.
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const cb = e.clipboardData || window.clipboardData;
      const text = cb ? cb.getData('text') : '';
      el.value = sanitizeDecimal(text);
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

// Persist a new symbol's spec to specs.json so it joins the dropdown permanently.
async function onSaveSpec() {
  const sym = currentSymbol();
  const msg = $('saveSpecMsg');
  if (!sym) { msg.textContent = 'Enter a symbol name first.'; return; }

  const body = {
    symbol: sym,
    minQty: $('sp-minQty').value,
    qtyStep: $('sp-qtyStep').value,
    minNotional: $('sp-minNotional').value,
    contractValue: $('sp-contractValue').value,
  };
  const resp = await fetch('/api/specs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    msg.textContent = 'Save failed: ' + (data.error || (data.errors && data.errors.join('; ')) || 'unknown');
    return;
  }

  // Reload specs, rebuild the dropdown, and select the newly-saved symbol.
  knownSpecs = await (await fetch('/api/specs')).json();
  populateSymbols();
  $('symbolSelect').value = sym;
  msg.textContent = '';
  ['sp-minQty', 'sp-qtyStep', 'sp-minNotional', 'sp-contractValue', 'newSymbol'].forEach(id => { $(id).value = ''; });
  applySymbolSpecState(); // now shows saved/UNVERIFIED and hides the manual fields
}

// Build the symbol dropdown from saved specs, plus a "new symbol" escape hatch.
function populateSymbols() {
  const sel = $('symbolSelect');
  const symbols = Object.keys(knownSpecs).sort();
  const opts = symbols.map(s => {
    const tag = knownSpecs[s].verified ? '' : ' (unverified)';
    return `<option value="${escapeHtml(s)}">${escapeHtml(s + tag)}</option>`;
  });
  opts.push(`<option value="${NEW_SYMBOL}">➕ New symbol…</option>`);
  sel.innerHTML = opts.join('');
}

// The effective symbol: the dropdown value, or the typed name when "new".
function currentSymbol() {
  const sel = $('symbolSelect').value;
  if (sel === NEW_SYMBOL) return ($('newSymbol').value || '').trim().toUpperCase();
  return (sel || '').trim().toUpperCase();
}

// ---------- Plan / acknowledgment ----------

// Honest "losses to halve" — ceil, matching the server (see server.js comment).
function lossesToHalve(account, risk) {
  if (!(risk > 0) || !(account > 0) || risk >= account) return 0;
  return Math.ceil(Math.log(0.5) / Math.log(1 - risk / account));
}

async function refreshPlan() {
  const data = await (await fetch('/api/plan')).json();
  currentPlan = data.plan;
  seedTradeInputs();   // (re)seed the per-trade account/risk from the saved plan
  renderAckLive();
}

// Seed the per-trade override inputs from the saved plan baseline.
function seedTradeInputs() {
  $('tradeAccount').value = currentPlan.account;
  $('tradeRisk').value = currentPlan.risk;
}

// Recompute the acknowledgment strip live from whatever account/risk are in the
// form (leverage stays plan-fixed). Flags when the values are off-plan so
// the trader is never insulated from the risk math.
function renderAckLive() {
  const account = Number($('tradeAccount').value);
  const risk = Number($('tradeRisk').value);
  const committed = Number($('committedMargin').value) > 0 ? Number($('committedMargin').value) : 0;
  const available = account - committed;
  const leverage = currentPlan.leverage;
  const valid = account > 0 && risk > 0 && risk < account && available > 0;

  $('ack-account').textContent = isFinite(account) && account > 0 ? fmt.usd(account) : '—';
  $('ack-risk').textContent = isFinite(risk) && risk > 0 ? fmt.usd(risk) : '—';
  $('ack-lev').textContent = leverage + 'x';

  if (valid) {
    // Risk % stays on the full account; the window floor uses available margin.
    $('ack-riskpct').textContent = fmt.pct1((risk / account) * 100);
    $('ack-halve').textContent = '~' + lossesToHalve(account, risk);
    const floorPct = risk / (available * leverage), ceilingPct = 1 / leverage;
    $('ack-window').textContent = fmt.pct(floorPct * 100) + ' – ' + fmt.pct(ceilingPct * 100);
  } else {
    $('ack-riskpct').textContent = '—';
    $('ack-halve').textContent = '—';
    $('ack-window').textContent = '—';
  }

  const offPlan = account !== currentPlan.account || risk !== currentPlan.risk;
  const note = $('planNote');
  if (offPlan) {
    $('offPlanText').textContent =
      `Per-trade override — your trading plan is ${fmt.usd(currentPlan.account)} account / ${fmt.usd(currentPlan.risk)} risk.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}

function openAmend() {
  $('am-account').value = currentPlan.account;
  $('am-risk').value = currentPlan.risk;
  $('am-lev').value = currentPlan.leverage;
  $('amendPreview').classList.add('hidden');
  $('amendPanel').classList.remove('hidden');
}

async function onPreview() {
  const body = {
    account: $('am-account').value,
    risk: $('am-risk').value,
    leverage: $('am-lev').value,
  };
  const resp = await fetch('/api/plan/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await resp.json();
  const box = $('amendPreview');
  box.classList.remove('hidden');
  if (!data.ok) {
    box.innerHTML = '<h4>Invalid</h4><ul>' + data.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
    return;
  }
  const p = data.proposed, k = data.consequences;
  box.innerHTML =
    '<h4>Consequences of the proposed plan</h4>' +
    pvRow('Account', fmt.usd(p.account)) +
    pvRow('Risk per trade', fmt.usd(p.risk)) +
    pvRow('Leverage', p.leverage + 'x') +
    pvRow('Risk as % of account', fmt.pct1(k.riskPctAcct)) +
    pvRow('Consecutive losses to halve account', '~' + k.lossesToHalve) +
    pvRow('New tradeable stop window', fmt.pct(k.floorPct * 100) + ' – ' + fmt.pct(k.ceilingPct * 100)) +
    '<div class="pv-actions">' +
    '<button type="button" id="confirmAmendBtn">Confirm &amp; save plan</button>' +
    '<button type="button" id="abortAmendBtn" class="secondary">Keep current</button>' +
    '</div>';
  $('confirmAmendBtn').addEventListener('click', () => commitAmend(p));
  $('abortAmendBtn').addEventListener('click', () => $('amendPanel').classList.add('hidden'));
}

function pvRow(label, val) {
  return `<div class="pv-row"><span class="lbl">${escapeHtml(label)}</span><span class="mono">${escapeHtml(val)}</span></div>`;
}

async function commitAmend(proposed) {
  const resp = await fetch('/api/plan/amend', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...proposed, confirm: true }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) { alert("Couldn't save plan: " + (data.error || 'unknown')); return; }
  $('amendPanel').classList.add('hidden');
  await refreshPlan();
}

// ---------- Spec state for the typed symbol ----------

function applySymbolSpecState() {
  // Reveal the free-text field only when "New symbol…" is chosen.
  const isNew = $('symbolSelect').value === NEW_SYMBOL;
  $('newSymbolLabel').classList.toggle('hidden', !isNew);

  const sym = currentSymbol();
  const line = $('specStatusLine');
  const fields = $('specFields');

  if (sym && knownSpecs[sym]) {
    const verified = !!knownSpecs[sym].verified;
    line.className = 'spec-status ' + (verified ? 'verified' : 'unverified');
    line.textContent = verified
      ? `spec: saved/verified — ${sym}`
      : `spec: saved/UNVERIFIED — confirm ${sym} on the Zoomex contract panel before the first trade.`;
    line.classList.remove('hidden');
    fields.classList.add('hidden');
  } else if (sym) {
    line.className = 'spec-status unverified';
    line.textContent = `No saved spec for ${sym} — enter it below, then "Save symbol to dropdown".`;
    line.classList.remove('hidden');
    fields.classList.remove('hidden');
  } else {
    line.classList.add('hidden');
    fields.classList.add('hidden');
  }
}

// ---------- Calculate ----------

function readForm() {
  const num = (id) => { const v = $(id).value; return v === '' ? NaN : Number(v); };
  const sym = currentSymbol();
  const targetVal = $('target').value;
  const body = {
    symbol: sym,
    direction: document.querySelector('input[name="direction"]:checked').value,
    marginMode: $('marginMode').value,
    // Per-trade account/risk overrides; blank falls back to the plan baseline.
    account: $('tradeAccount').value === '' ? null : Number($('tradeAccount').value),
    risk: $('tradeRisk').value === '' ? null : Number($('tradeRisk').value),
    // Margin tied up in other open trades; blank = 0.
    committedMargin: $('committedMargin').value === '' ? null : Number($('committedMargin').value),
    entry: num('entry'),
    stop: num('stop'),
    // Optional: omit entirely when blank so the server treats it as no target.
    target: targetVal === '' ? null : Number(targetVal),
    // Optional: blank falls back to the server's default taker rate.
    takerFeePct: $('takerFeePct').value === '' ? null : Number($('takerFeePct').value),
  };
  // Only attach a manual spec when the symbol is unknown.
  if (sym && !knownSpecs[sym]) {
    body.spec = {
      minQty: $('sp-minQty').value,
      qtyStep: $('sp-qtyStep').value,
      minNotional: $('sp-minNotional').value,
      contractValue: $('sp-contractValue').value,
    };
  }
  return body;
}

async function onCalculate(e) {
  e.preventDefault();
  const resp = await fetch('/api/calculate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readForm()),
  });
  renderResult(await resp.json());
}

function renderResult(data) {
  const vBox = $('violations'), wBox = $('warnings'), rBox = $('results');

  // UX validation errors.
  if (!data.ok) {
    vBox.classList.remove('hidden');
    vBox.innerHTML = '<h3>Invalid inputs</h3><ul>' +
      data.validationErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
    wBox.classList.add('hidden');
    rBox.classList.add('hidden');
    return;
  }

  // Violations (hard refusals).
  if (data.violations && data.violations.length > 0) {
    vBox.classList.remove('hidden');
    vBox.innerHTML = '<h3>REFUSED — plan / exchange gate</h3><ul>' +
      data.violations.map(v => `<li>${escapeHtml(v.message)}</li>`).join('') + '</ul>';
  } else {
    vBox.classList.add('hidden');
  }

  // Warnings (loud but non-blocking).
  if (data.warnings && data.warnings.length > 0) {
    wBox.classList.remove('hidden');
    wBox.innerHTML = '<h3>Warning</h3><ul>' +
      data.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('') + '</ul>';
  } else {
    wBox.classList.add('hidden');
  }

  // Margin-mode (and direction) refusals carry no math at all.
  if (data.preMath) {
    rBox.classList.add('hidden');
    return;
  }

  const r = data.result;
  const tb = r.targetBlock;
  rBox.classList.remove('hidden');
  rBox.classList.remove('accepted', 'refused');
  rBox.classList.add(data.blocked ? 'refused' : 'accepted');

  // Status pill — the first thing the eye should catch.
  const pill = $('r-pill');
  if (data.blocked) {
    pill.className = 'r-pill refused';
    pill.textContent = '✗ REFUSED';
  } else if (data.warnings && data.warnings.length > 0) {
    pill.className = 'r-pill warn';
    pill.textContent = '✓ ACCEPTED — see warning';
  } else {
    pill.className = 'r-pill accepted';
    pill.textContent = '✓ ACCEPTED';
  }

  // The answer.
  if (data.blocked) {
    $('r-contracts').innerHTML = '<span class="blocked">REFUSED</span>';
    $('r-base').textContent = '';
  } else {
    $('r-contracts').textContent = fmt.qty(r.qty);
    $('r-base').textContent = data.base;
  }
  $('r-heroSub').textContent = `${data.inputs.direction.toUpperCase()} · ${data.symbol} (${data.specStatus})`;

  // The numbers that matter: cost, risk, and — with a target — reward.
  $('r-margin').textContent = fmt.usd(r.marginRequired) + '  (' + data.plan.leverage + '×)';
  $('r-netLoss').textContent = fmt.usd(r.netLossAtStop);
  if (tb) {
    $('r-profitCell').classList.remove('hidden');
    $('r-rrCell').classList.remove('hidden');
    $('r-netProfit').textContent = fmt.usd(tb.netProfit);
    $('r-netRR').textContent = fmt.rr(tb.netRR);
  } else {
    $('r-profitCell').classList.add('hidden');
    $('r-rrCell').classList.add('hidden');
  }

  // Supporting detail — quiet, scannable.
  const lines = [];
  let lvl = `entry ${fmt.price(data.inputs.entry)} · stop ${fmt.price(data.inputs.stop)} (${fmt.pct(r.stopPct * 100)})`;
  if (tb) lvl += ` · target ${fmt.price(tb.target)} (${fmt.pct(tb.targetPct * 100)})`;
  lines.push(lvl);

  const winState = r.insideWindow ? '<span class="ok">inside</span>' : '<span class="bad">OUTSIDE</span>';
  lines.push(`liq ~${fmt.price(r.liqPrice)} (${fmt.pct(r.liqPct * 100)} away) · window ${fmt.pct(r.floorPct * 100)}–${fmt.pct(r.ceilingPct * 100)} ${winState}`);

  let fee = `position ${fmt.usd(r.positionValue)} · fees ${fmt.usd(r.feesAtStop)} r/t (${r.feeRatePct}%/side)`;
  if (tb) fee += ` · at target ${fmt.usd(tb.feesAtTarget)}`;
  lines.push(fee);

  if (r.committedMargin > 0) {
    lines.push(`margin ${fmt.usd(r.availableMargin)} available (−${fmt.usd(r.committedMargin)} committed) · ${fmt.usd(r.marginAfter)} left after`);
  }

  let gross = `intended risk ${fmt.usd(r.intendedRisk)} · gross loss ${fmt.usd(r.grossLossAtStop)}`;
  if (tb) gross += ` · gross profit ${fmt.usd(tb.grossProfit)} (${fmt.rr(tb.grossRR)})`;
  lines.push(gross);

  let acct = `account ${fmt.usd(data.plan.account)} · risk ${fmt.pct1(r.riskPctAcct)} of account · ~${r.lossesToHalve} losses to halve`;
  if (tb) acct += ` · break-even WR ${fmt.pct1(tb.breakEvenWinRate)}`;
  lines.push(acct);

  $('r-fine').innerHTML = lines.map(s => `<div>${s}</div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
