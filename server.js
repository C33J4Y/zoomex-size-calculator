// Zoomex Position Sizer — localhost-only Express server.
//
// Mirrors the structure of the BTC sizing calculator: a pure calculate() core,
// authoritative server-side validation, hard "violations" vs soft "warnings",
// and constants/plan kept out of the UI. Differences are domain-only:
// this sizes Zoomex USDT-margined alt perps under an isolated-margin plan,
// answering ONE question honestly — how many contracts do I buy? SIZE is the
// output, STOP is the input, never the reverse.

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || config.PORT;
const PLAN_FILE = path.join(__dirname, config.PLAN_FILE);
const SPECS_FILE = path.join(__dirname, config.SPECS_FILE);

app.use(express.json());
// Serve the UI with no-store so the browser always loads the freshest HTML/JS/CSS.
// This is a localhost dev tool — there's no benefit to caching assets, and caching
// causes stale-script bugs (e.g. an old app.js calling renamed API routes).
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// ---------- Plan & spec persistence (the only files this app writes) ----------

function readPlan() {
  // Create plan.json with seed defaults on first run if missing.
  if (!fs.existsSync(PLAN_FILE)) {
    fs.writeFileSync(PLAN_FILE, JSON.stringify(config.DEFAULT_PLAN, null, 2));
  }
  let c;
  try {
    c = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  } catch (e) {
    c = { ...config.DEFAULT_PLAN };
  }
  // Backfill any missing keys so an old/partial file still works.
  for (const k of Object.keys(config.DEFAULT_PLAN)) {
    if (c[k] === undefined) c[k] = config.DEFAULT_PLAN[k];
  }
  return c;
}

function writePlan(plan) {
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
}

function readSpecs() {
  if (!fs.existsSync(SPECS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SPECS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeSpecs(specs) {
  fs.writeFileSync(SPECS_FILE, JSON.stringify(specs, null, 2));
}

// ---------- Shared risk math ----------

// How many consecutive full-risk losers (compounding on the running balance)
// drive the account to half or below: 0.75^n <= 0.5  ->  n = ceil(...).
// NOTE: the original CLI spec wrote floor(...), but floor undercounts (at 25%
// risk it yields 2, while 0.75^2 = 0.5625 is still ABOVE half — it actually
// takes 3 losers to cross below). We use ceil so the displayed number is the
// honest "losses to reach half," matching the spec's own stated "~3 at $50/$200".
function consecutiveLossesToHalve(account, risk) {
  if (risk <= 0 || account <= 0 || risk >= account) return 0;
  return Math.ceil(Math.log(0.5) / Math.log(1 - risk / account));
}

// Tradeable stop window as fractions of entry price.
function stopWindow(account, risk, leverage) {
  return {
    floorPct: risk / (account * leverage), // tighter -> position too big for margin
    ceilingPct: 1 / leverage,              // wider  -> liquidation before the stop
  };
}

// Round a base quantity DOWN to a valid exchange step (never up).
function floorToStep(value, step) {
  const steps = Math.floor(value / step + 1e-9);
  return Number((steps * step).toFixed(10));
}

// ---------- Input validation (UX errors, distinct from plan violations) ----------

function validateInputs(input, spec) {
  const errors = [];
  const numField = (v, name) => {
    if (typeof v !== 'number' || !isFinite(v)) {
      errors.push(`${name} must be a number`);
      return false;
    }
    if (v <= 0) errors.push(`${name} must be > 0`);
    return true;
  };

  numField(input.entry, 'Entry price');
  numField(input.stop, 'Stop price');

  // Target is OPTIONAL (it does not drive size). Only validate it if provided.
  if (input.target !== undefined && input.target !== null && input.target !== '') {
    if (typeof input.target !== 'number' || !isFinite(input.target) || input.target <= 0) {
      errors.push('Target price must be a positive number (or left blank)');
    }
  }

  // Taker fee is OPTIONAL (defaults from config). Zero is allowed (maker/rebate).
  if (input.takerFeePct !== undefined && input.takerFeePct !== null && input.takerFeePct !== '') {
    if (typeof input.takerFeePct !== 'number' || !isFinite(input.takerFeePct) || input.takerFeePct < 0) {
      errors.push('Taker fee % must be a number >= 0 (or left blank)');
    }
  }

  if (input.direction !== 'long' && input.direction !== 'short') {
    errors.push('Direction must be "long" or "short"');
  }
  if (typeof input.marginMode !== 'string' || input.marginMode.trim() === '') {
    errors.push('Margin mode must be declared (isolated or cross)');
  }
  if (!spec) {
    errors.push('No contract spec for this symbol — enter minQty / qtyStep / minNotional / contractValue');
  } else {
    numField(spec.minQty, 'minQty');
    numField(spec.qtyStep, 'qtyStep');
    numField(spec.minNotional, 'minNotional');
    numField(spec.contractValue, 'contractValue');
  }
  return errors;
}

// ---------- Pure calculation ----------
//
// Resolves the spec, runs the six validation gates, and returns either a refusal
// (blocked=true with violations) or a fully-sized position. Gate order matters:
// the margin-mode gate fires BEFORE any math, exactly like the CLI.

function calculate(input, plan, specs) {
  const symbol = (input.symbol || '').toUpperCase();

  // Spec resolution: a known symbol uses its STORED spec (server-authoritative);
  // an unknown symbol uses the spec typed into the form, marked UNVERIFIED.
  // Nothing is persisted — this is the lean, no-persistence build.
  let spec = null;
  let specStatus = null;
  if (specs[symbol]) {
    const s = specs[symbol];
    spec = {
      minQty: s.minQty,
      qtyStep: s.qtyStep,
      minNotional: s.minNotional !== undefined ? s.minNotional : config.DEFAULT_MIN_NOTIONAL,
      contractValue: s.contractValue !== undefined ? s.contractValue : config.DEFAULT_CONTRACT_VALUE,
      verified: !!s.verified,
    };
    specStatus = s.verified ? 'saved/verified' : 'saved/UNVERIFIED';
  } else if (input.spec && typeof input.spec === 'object') {
    spec = {
      minQty: Number(input.spec.minQty),
      qtyStep: Number(input.spec.qtyStep),
      minNotional: input.spec.minNotional === '' || input.spec.minNotional == null
        ? config.DEFAULT_MIN_NOTIONAL : Number(input.spec.minNotional),
      contractValue: input.spec.contractValue === '' || input.spec.contractValue == null
        ? config.DEFAULT_CONTRACT_VALUE : Number(input.spec.contractValue),
      verified: false,
    };
    specStatus = 'manual/UNVERIFIED';
  }

  const validationErrors = validateInputs(input, spec);
  if (validationErrors.length > 0) return { ok: false, validationErrors };

  const { account, risk, leverage } = plan;
  const requiredMode = (plan.margin_mode_required || 'isolated').toLowerCase();
  const { direction, entry, stop } = input;
  const marginMode = String(input.marginMode).toLowerCase();
  const takerFeePct = (typeof input.takerFeePct === 'number' && isFinite(input.takerFeePct) && input.takerFeePct >= 0)
    ? input.takerFeePct : config.DEFAULT_TAKER_FEE_PCT;

  const violations = [];
  const warnings = [];

  // GATE 1: margin mode — hard gate BEFORE any math. Under cross the whole
  // account backstops the position; a gap through the stop realizes a loss
  // capped at the ACCOUNT, not the risk budget. That breaks the only promise
  // this tool makes, so refuse outright with nothing computed.
  if (marginMode !== requiredMode) {
    return {
      ok: true,
      blocked: true,
      preMath: true, // signals the UI to show no numbers at all
      symbol, specStatus,
      violations: [{
        type: 'margin_mode',
        message: `Margin mode declared "${marginMode}" but the plan requires ${requiredMode}. ` +
          `Under cross the whole account backstops the position and the stop no longer caps the loss ` +
          `at the risk budget. Set isolated and recalculate.`,
      }],
      warnings: [],
    };
  }

  // GATE 2: direction / stop consistency. Long stops below entry, short above.
  if (direction === 'long' && !(stop < entry)) {
    violations.push({ type: 'direction_stop', message: `LONG requires the stop (${fmtPrice(stop)}) BELOW entry (${fmtPrice(entry)}).` });
  }
  if (direction === 'short' && !(stop > entry)) {
    violations.push({ type: 'direction_stop', message: `SHORT requires the stop (${fmtPrice(stop)}) ABOVE entry (${fmtPrice(entry)}).` });
  }

  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0) {
    violations.push({ type: 'zero_distance', message: 'Stop distance must be greater than zero.' });
  }

  // If direction/stop is incoherent there is no honest position to size.
  if (violations.length > 0) {
    return { ok: true, blocked: true, preMath: true, symbol, specStatus, violations, warnings };
  }

  // ---------- Fees (round-trip taker, on notional both sides) ----------
  // Zoomex charges a percentage taker fee per side and no per-contract fee.
  // We size against NET loss INCLUDING fees, so being stopped out — fees and all —
  // costs the risk budget and no more, which is the only promise this tool makes.
  // Assumes taker on BOTH entry and exit (worst case); lower the rate if you enter
  // as a maker. feeRate=0 reproduces the pure gross sizing.
  const feeRate = takerFeePct / 100;

  // ---------- The math (linear USDT perpetuals), net of round-trip fees ----------
  // Per base unit the all-in loss at the stop is: price move + entry-side fee +
  // stop-side fee. Sizing against that caps the all-in loss at the risk budget.
  const netLossPerUnit = stopDistance + (entry + stop) * feeRate;
  const rawQty = risk / netLossPerUnit;               // units whose all-in loss = budget
  const qty = floorToStep(rawQty, spec.qtyStep);      // round DOWN to a valid step
  const positionValue = qty * entry;                  // notional USDT
  const marginRequired = positionValue / leverage;

  const grossLossAtStop = qty * stopDistance;         // price move only
  const entryFee = positionValue * feeRate;           // taker fee entering
  const exitFeeAtStop = qty * stop * feeRate;         // taker fee exiting at the stop
  const feesAtStop = entryFee + exitFeeAtStop;        // round trip
  const netLossAtStop = grossLossAtStop + feesAtStop; // all-in; <= budget after round-down

  const liqPct = 1 / leverage;                        // ~10% adverse at 10x (approx)
  const liqPrice = direction === 'long'
    ? entry * (1 - liqPct)
    : entry * (1 + liqPct);
  const stopPct = stopDistance / entry;

  // Committed margin: dollars already tied up in OTHER open positions. The new
  // trade must fit in what's left, so gate 5 checks against available margin and
  // the window floor widens accordingly. committed=0 reproduces the old behavior.
  const committedMargin = Number(input.committedMargin) > 0 ? Number(input.committedMargin) : 0;
  const availableMargin = account - committedMargin;
  const marginAfter = availableMargin - marginRequired; // headroom left for the next leg

  // Tradeable window: floor is the tightest stop whose position fits AVAILABLE
  // margin; ceiling is the liquidation distance. Risk % stays based on the full
  // account — only margin headroom is reduced by other open trades.
  const floorPct = availableMargin > 0 ? risk / (availableMargin * leverage) : Infinity;
  const ceilingPct = 1 / leverage;
  const insideWindow = stopPct >= floorPct && stopPct <= ceilingPct;

  // GATE 3: qty must clear the exchange minimum. NEVER round up to reach it.
  if (qty < spec.minQty) {
    violations.push({
      type: 'min_qty',
      message: `Computed qty ${fmtQty(qty)} is below the exchange minQty ${fmtQty(spec.minQty)} — ` +
        `untradeable at this risk/account size. The structural stop is too wide for the budget. ` +
        `(raw_qty=${fmtQty(rawQty)})`,
    });
  }

  // GATE 4: notional floor.
  if (positionValue < spec.minNotional) {
    violations.push({
      type: 'min_notional',
      message: `Position value $${positionValue.toFixed(4)} is below minNotional $${spec.minNotional.toFixed(2)} — untradeable.`,
    });
  }

  // GATE 5: margin must fit AVAILABLE margin (account minus other open trades).
  // Tighter stop = bigger position = more margin.
  if (marginRequired > availableMargin) {
    const committedNote = committedMargin > 0
      ? ` available margin $${availableMargin.toFixed(2)} ($${account.toFixed(2)} account − $${committedMargin.toFixed(2)} committed to open trades)`
      : ` account $${account.toFixed(2)}`;
    violations.push({
      type: 'margin_exceeds_account',
      message: `Margin required $${marginRequired.toFixed(2)} EXCEEDS${committedNote}. ` +
        `The stop is too TIGHT for the margin you have free: a tighter stop means a bigger position, which ` +
        `needs more margin. Widen the stop to the next structural level, close another position to free margin, ` +
        `lower risk, or raise leverage (accepting the closer liquidation). ` +
        `Tradeable window: ${(floorPct * 100).toFixed(2)}%–${(ceilingPct * 100).toFixed(2)}% (this stop: ${(stopPct * 100).toFixed(2)}%).`,
    });
  }

  // GATE 6: liquidation sanity — soft but LOUD warning if the stop sits beyond liquidation.
  if (stopPct > liqPct) {
    warnings.push({
      type: 'liq_before_stop',
      message: `DANGER: stop distance ${(stopPct * 100).toFixed(2)}% is WIDER than the liquidation distance ` +
        `${(liqPct * 100).toFixed(2)}%. The position liquidates BEFORE the stop is hit. Under isolated margin ` +
        `the loss becomes the committed margin ($${marginRequired.toFixed(2)}) — more than the intended risk, ` +
        `though still capped below the account. The stop never gets to act.`,
    });
  }

  // Soft warning: fees eating a large share of the risk budget (stop too tight
  // relative to fees, or an unusually high fee rate). Mirrors the reference app.
  const feeBurdenPct = risk > 0 ? (feesAtStop / risk) * 100 : 0;
  if (feeBurdenPct > config.HIGH_FEE_THRESHOLD_PCT) {
    warnings.push({
      type: 'high_fees',
      message: `Round-trip fees are $${feesAtStop.toFixed(2)}, ${feeBurdenPct.toFixed(1)}% of your $${risk.toFixed(2)} ` +
        `risk budget at a ${takerFeePct}% taker rate. That is high — the stop is tight relative to fees. ` +
        `Confirm the setup justifies the fee load.`,
    });
  }

  // ---------- Optional profit target → potential P&L and reward:risk ----------
  // Target does NOT drive size (size comes from risk + stop). It only reports the
  // reward side. Profit is shown both GROSS and NET of round-trip taker fees.
  let targetBlock = null;
  if (typeof input.target === 'number' && isFinite(input.target) && input.target > 0) {
    const wrongSide =
      (direction === 'long' && input.target <= entry) ||
      (direction === 'short' && input.target >= entry);
    if (wrongSide) {
      warnings.push({
        type: 'target_direction',
        message: `Target ${fmtPrice(input.target)} is on the wrong side of entry for a ${direction} trade — ` +
          `ignored for P&L. A long takes profit ABOVE entry; a short BELOW.`,
      });
    } else {
      const targetDistance = Math.abs(input.target - entry);
      const targetPct = targetDistance / entry;
      const grossProfit = qty * targetDistance;
      const exitFeeAtTarget = qty * input.target * feeRate;   // taker fee exiting at target
      const feesAtTarget = entryFee + exitFeeAtTarget;        // round trip
      const netProfit = grossProfit - feesAtTarget;
      const grossRR = grossLossAtStop > 0 ? grossProfit / grossLossAtStop : null;
      const netRR = netLossAtStop > 0 ? netProfit / netLossAtStop : null;
      const beDenom = netProfit + netLossAtStop;
      const breakEvenWinRate = beDenom > 0 ? (netLossAtStop / beDenom) * 100 : null;
      targetBlock = {
        target: input.target, targetDistance, targetPct,
        grossProfit, feesAtTarget, netProfit,
        grossRR, netRR, breakEvenWinRate,
      };
    }
  }

  const blocked = violations.length > 0;
  const riskPctAcct = (risk / account) * 100;
  const lossesToHalve = consecutiveLossesToHalve(account, risk);
  const base = symbol.replace('USDT', '');

  return {
    ok: true,
    blocked,
    preMath: false,
    symbol,
    base,
    specStatus,
    violations,
    warnings,
    inputs: { direction, entry, stop, marginMode },
    plan: { account, risk, leverage, marginModeRequired: requiredMode },
    result: {
      stopDistance, stopPct,
      floorPct, ceilingPct, insideWindow,
      rawQty, qty,
      positionValue, marginRequired,
      committedMargin, availableMargin, marginAfter,
      feeRatePct: takerFeePct,
      intendedRisk: risk,
      grossLossAtStop, entryFee, feesAtStop, netLossAtStop,
      liqPct, liqPrice,
      riskPctAcct, lossesToHalve,
      targetBlock,
    },
  };
}

// ---------- Formatting helpers (mirrored on the client) ----------

function fmtPrice(x) {
  if (x == null || !isFinite(x)) return '—';
  let s = Number(x).toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? '0' : s;
}

function fmtQty(x) {
  if (x == null || !isFinite(x)) return '—';
  if (Number.isInteger(x)) return String(x);
  return Number(x).toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

// ---------- Routes ----------

// Current plan + the standing acknowledgment math + the tradeable window.
app.get('/api/plan', (req, res) => {
  const plan = readPlan();
  const { floorPct, ceilingPct } = stopWindow(plan.account, plan.risk, plan.leverage);
  res.json({
    plan,
    acknowledgment: {
      riskPctAcct: (plan.risk / plan.account) * 100,
      lossesToHalve: consecutiveLossesToHalve(plan.account, plan.risk),
    },
    window: { floorPct, ceilingPct },
  });
});

// Known specs, so the client can tell verified symbols from ones needing manual entry.
app.get('/api/specs', (req, res) => {
  res.json(readSpecs());
});

// Save (or overwrite) a contract spec so the symbol persists in the dropdown.
// Always stored as verified:false — confirm on Zoomex before the first trade.
// Mirrors the Python CLI's self-populating specs.json.
app.post('/api/specs', (req, res) => {
  const sym = String((req.body && req.body.symbol) || '').trim().toUpperCase();
  if (!sym) return res.status(400).json({ ok: false, error: 'Symbol name required' });

  const minQty = Number(req.body.minQty);
  const qtyStep = Number(req.body.qtyStep);
  const minNotional = (req.body.minNotional === '' || req.body.minNotional == null)
    ? config.DEFAULT_MIN_NOTIONAL : Number(req.body.minNotional);
  const contractValue = (req.body.contractValue === '' || req.body.contractValue == null)
    ? config.DEFAULT_CONTRACT_VALUE : Number(req.body.contractValue);

  const errors = [];
  if (!(minQty > 0)) errors.push('minQty must be > 0');
  if (!(qtyStep > 0)) errors.push('qtyStep must be > 0');
  if (!(minNotional > 0)) errors.push('minNotional must be > 0');
  if (!(contractValue > 0)) errors.push('contractValue must be > 0');
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const specs = readSpecs();
  const existed = !!specs[sym];
  specs[sym] = { minQty, qtyStep, minNotional, contractValue, verified: false };
  writeSpecs(specs);
  res.json({ ok: true, symbol: sym, spec: specs[sym], existed });
});

// Pure sizing calc — never writes anything.
app.post('/api/calculate', (req, res) => {
  const b = req.body || {};
  const plan = readPlan();

  // Per-trade overrides: account and risk may be supplied for THIS calc only.
  // They never rewrite plan.json — the saved plan stays the baseline and is
  // changed only through the amendment flow. Leverage stays plan-fixed.
  const eff = { ...plan };
  if (b.account !== undefined && b.account !== null && b.account !== '') eff.account = Number(b.account);
  if (b.risk !== undefined && b.risk !== null && b.risk !== '') eff.risk = Number(b.risk);

  const errs = [];
  if (!(eff.account > 0)) errs.push('Account must be a positive number');
  if (!(eff.risk > 0)) errs.push('Risk per trade must be a positive number');
  if (eff.risk >= eff.account) errs.push('Risk per trade must be smaller than the account');

  // Committed margin: optional, $ tied up in other open trades.
  if (b.committedMargin !== undefined && b.committedMargin !== null && b.committedMargin !== '') {
    const committed = Number(b.committedMargin);
    if (!isFinite(committed) || committed < 0) {
      errs.push('Committed margin must be 0 or a positive number');
    } else if (committed >= eff.account) {
      errs.push('Committed margin must be less than the account (no margin would be free)');
    }
  }
  if (errs.length) return res.json({ ok: false, validationErrors: errs });

  res.json(calculate(b, eff, readSpecs()));
});

// Amendment preview: the CONSEQUENCES of a proposed plan, shown BEFORE saving.
app.post('/api/plan/preview', (req, res) => {
  const current = readPlan();
  const account = numOr(req.body.account, current.account);
  const risk = numOr(req.body.risk, current.risk);
  const leverage = numOr(req.body.leverage, current.leverage);

  const errors = [];
  if (!(account > 0)) errors.push('account must be > 0');
  if (!(risk > 0)) errors.push('risk must be > 0');
  if (!(leverage > 0)) errors.push('leverage must be > 0');
  if (risk >= account) errors.push('risk must be smaller than account');
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const { floorPct, ceilingPct } = stopWindow(account, risk, leverage);
  res.json({
    ok: true,
    proposed: { account, risk, leverage },
    consequences: {
      riskPctAcct: (risk / account) * 100,
      lossesToHalve: consecutiveLossesToHalve(account, risk),
      floorPct, ceilingPct,
    },
  });
});

// Amendment commit: requires explicit confirm. Writes account/risk/leverage only;
// margin_mode_required stays isolated — that gate is not a UI knob.
app.post('/api/plan/amend', (req, res) => {
  if (req.body.confirm !== true) {
    return res.status(400).json({ ok: false, error: 'Confirmation required: send { "confirm": true }' });
  }
  const current = readPlan();
  const account = numOr(req.body.account, current.account);
  const risk = numOr(req.body.risk, current.risk);
  const leverage = numOr(req.body.leverage, current.leverage);

  if (!(account > 0) || !(risk > 0) || !(leverage > 0) || risk >= account) {
    return res.status(400).json({ ok: false, error: 'Invalid plan values' });
  }
  const next = {
    account: Number(account),
    risk: Number(risk),
    leverage: Number(leverage),
    margin_mode_required: current.margin_mode_required || 'isolated',
  };
  writePlan(next);
  res.json({ ok: true, plan: next });
});

function numOr(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`Zoomex Position Sizer running at http://localhost:${PORT}`);
  });
}

module.exports = { app, calculate, consecutiveLossesToHalve, stopWindow, floorToStep };
