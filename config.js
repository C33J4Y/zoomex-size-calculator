// Zoomex Position Sizer — bootstrap defaults and fixed product constants.
//
// The LIVE plan (account / risk / leverage / required margin mode) is persisted
// in plan.json and changed ONLY through the in-app amendment flow, which shows
// the consequences (risk %, losses-to-halve, new tradeable window) BEFORE saving.
// Risk is not a knob to spin mid-session on a feeling — amending it is a deliberate
// conversation with yourself, shown with its math.
//
// The values below are only the seed used to create plan.json on first run.

module.exports = {
  // Seed plan written to plan.json if the file is missing.
  DEFAULT_PLAN: {
    account: 200.0,
    risk: 50.0,
    leverage: 10,
    margin_mode_required: 'isolated',
  },
  HYPERLIQUID_DEFAULT_PLAN: {
    account: 2900.0,
    risk: 500.0,
    leverage: 20,
    margin_mode_required: 'isolated',
  },

  PLAN_FILE: 'plan.json',
  HYPERLIQUID_PLAN_FILE: 'hyperliquid-plan.json',
  SPECS_FILE: 'specs.json',

  // Applied when a contract spec omits these fields.
  DEFAULT_MIN_NOTIONAL: 5.0,
  DEFAULT_CONTRACT_VALUE: 1.0,

  // Default Zoomex taker fee (%) per side. Zoomex (Bybit engine) charges a
  // percentage taker fee on notional and has no per-contract fee. Verify your
  // tier on the exchange — VIP/volume tiers lower it. Overridable per trade.
  DEFAULT_TAKER_FEE_PCT: 0.06,
  HYPERLIQUID_TAKER_FEE_PCT: 0.045,

  // Soft warning: round-trip fees exceeding this % of the risk budget flag a
  // high-fee trade (stop too tight relative to fees, or fee rate too high).
  HIGH_FEE_THRESHOLD_PCT: 15,

  // Loopback-only port. The reference BTC sizing calculator owns 3000, so this
  // one defaults to 3001 — both can run simultaneously. Override with PORT=NNNN.
  PORT: 3001,
};
