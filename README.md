# Perpetual Position Sizer

A localhost-only **position-sizing calculator** for [Zoomex](https://www.zoomex.com/) USDT-margined perpetuals and [Hyperliquid](https://hyperliquid.xyz/) BTC perpetuals. Select the exchange in the header. It answers one question honestly:

> Given a fixed dollar risk and a **structurally-placed stop**, how many contracts do I buy?

**SIZE is the output. STOP is the input. Never the reverse.** There is no "size-first" mode and no override button — that inversion is how trading accounts die. You place your stop where market structure says it belongs; the tool tells you the largest position that keeps a stop-out inside your risk budget, or refuses if no valid size exists.

It's a **web app** (`server.js` + `public/`) — Node + Express with a vanilla-JS UI. Zoomex continues to use local contract specs; Hyperliquid uses live public BTC contract metadata and a separate plan. No wallet connection or signing is used: enter your Hyperliquid account equity manually.

---

## Quick start

```bash
npm install        # Node 18+
npm start          # serves http://localhost:3001 (loopback only)
```

Open **http://localhost:3001**. The server binds to `127.0.0.1` only — it is not reachable from your network. It defaults to port **3001** so it can run alongside a companion BTC calculator on 3000; override with `PORT=NNNN npm start`.

---

## How sizing works

For a linear perpetual, the loss per BTC if price hits your stop is the price move **plus round-trip trading fees**. Sizing against that all-in loss caps the modeled stop-out at your risk budget and no more:

```
netLossPerUnit = |entry − stop| + (entry + stop) × feeRate
rawQty         = risk / netLossPerUnit
qty            = floorToStep(rawQty, qtyStep)      # always rounded DOWN
positionValue  = qty × entry
marginRequired = positionValue / leverage
```

`qty` is **always rounded down** to a valid exchange step — never up to reach a minimum — so actual risk is always ≤ your budget.

---

## The six gates

Before showing a contract count, the calculator runs six checks. The first five are **hard refusals** (no size shown); the sixth is a **loud warning** (still sizes).

| # | Gate | Rule | Why |
|---|------|------|-----|
| 1 | **Margin mode** | Plan requires `isolated`; declaring `cross` refuses *before any math* | Under cross the whole account backstops the position and the stop no longer caps the loss at the risk budget |
| 2 | **Direction / stop** | Long needs stop below entry; short needs stop above | A stop on the wrong side isn't a stop |
| 3 | **qty ≥ minQty** | Computed size must clear the exchange minimum | A stop so wide that size falls below the minimum is untradeable — never rounded up |
| 4 | **positionValue ≥ minNotional** | Notional must clear the exchange floor | Same — untradeable below the minimum |
| 5 | **margin ≤ available** | Required margin must fit the account (minus margin committed to other open trades) | A too-tight stop ⇒ bigger position ⇒ more margin than you hold. Widen the stop, lower risk, or raise leverage |
| 6 | **Liquidation before stop** ⚠️ | Warns if stop distance exceeds the liquidation distance (`1 / leverage`) | The position would liquidate before the stop acts |

---

## Fees & profit target

**Fees.** Zoomex defaults to `0.06%`; Hyperliquid defaults to the supplied `0.045%` taker fee per side. The calculator assumes taker on both entry and exit; edit the rate for your tier or execution assumption. Results separate gross price movement from net P&L including the fee estimate. Funding is not included.

**Hyperliquid BTC rules.** The server calls Hyperliquid's public `/info` metadata endpoint for BTC size precision and maximum leverage, caching the result for 15 minutes. Use **Refresh BTC rules** to bypass the cache. The $10 minimum notional is a configured assumption, not a field returned by that metadata endpoint. Hyperliquid gets its own ignored `hyperliquid-plan.json`, seeded with $2,900 equity, $500 risk, 20x leverage, and isolated margin. These are editable in the trading-plan flow. The Rabby wallet is not queried.

**Liquidation.** The displayed liquidation level uses the simple `1 / leverage` estimate. Actual liquidation depends on Hyperliquid maintenance-margin tiers, fees, and position/account state; do not treat that display as an exchange liquidation price. Stops can slip or gap, so realized losses can exceed the modeled risk.

**Profit target.** An optional target price reports the reward side — **gross/net profit, R:R, and break-even win rate**. It does **not** drive size; size comes only from risk + stop. There is no "size to a profit target" mode.

---

## The trading plan

`plan.json` holds Zoomex values; `hyperliquid-plan.json` independently holds Hyperliquid values. Each plan's account, risk, leverage, and required margin mode are:

```json
{
  "account": 200,
  "risk": 50,
  "leverage": 10,
  "margin_mode_required": "isolated"
}
```

Risk is not a knob to spin mid-trade on a feeling. The only way to change `account` / `risk` / `leverage` is the **Edit trading plan** flow, which shows the consequences — risk as % of account, consecutive losses to halve the account, and the new tradeable stop window — **before** you confirm. `margin_mode_required` stays `isolated` and is not a UI knob.

> **Note:** Neither plan file is committed. They are auto-created from the exchange-specific seed in `config.js` on first use. See [Data files](#data-files).

> The "consecutive losses to halve account" figure uses `ceil(ln 0.5 / ln(1 − risk/account))` — the honest count of losses to reach half (3 at the default $50/$200). An earlier spec used `floor`, which undercounts; the app uses `ceil` and documents the deviation in code.

---

## Contract specs

`specs.json` is the source for the **Symbol** dropdown, mapping each symbol to its contract spec:

```json
"ONDOUSDT": { "minQty": 1, "qtyStep": 1, "minNotional": 5, "contractValue": 1, "verified": true }
```

Choose **➕ New symbol…** in the UI to enter a spec from the Zoomex contract panel. Saved symbols are stored `verified: false` until you confirm them, and appear in the dropdown on every load. This file is **self-populating** — the app writes to it as you add symbols.

---

## HTTP API

All routes are served from `http://localhost:3001`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET`  | `/api/plan?exchange=zoomex\|hyperliquid` | Selected plan + standing acknowledgment + tradeable window |
| `GET`  | `/api/specs` | Known contract specs (the dropdown source) |
| `GET`  | `/api/hyperliquid/spec` | Fetch/cache live public BTC precision and leverage metadata |
| `POST` | `/api/specs` | Save a symbol's spec to `specs.json` (stored `verified: false`) |
| `POST` | `/api/calculate` | Pure sizing calc — **never writes anything** |
| `POST` | `/api/plan/preview` | Consequences of a proposed plan (no write) |
| `POST` | `/api/plan/amend` | Commit a new plan — requires `{ "confirm": true }` |

Example:

```bash
curl -s http://localhost:3001/api/calculate \
  -H 'content-type: application/json' \
  -d '{"symbol":"ONDOUSDT","direction":"long","marginMode":"isolated","entry":0.3379,"stop":0.3278}'
```

`/api/calculate` also accepts optional per-trade overrides — `account`, `risk`, `committedMargin` (margin tied up in other open positions), `target`, and `takerFeePct` — none of which rewrite `plan.json`.

---

## Configuration

Product constants and the first-run plan seed live in `config.js`:

| Key | Default | Purpose |
|-----|---------|---------|
| `DEFAULT_PLAN` | `{200, 50, 10, isolated}` | Seed written to `plan.json` on first run |
| `PORT` | `3001` | Loopback port (override with `PORT=NNNN`) |
| `DEFAULT_TAKER_FEE_PCT` | `0.06` | Taker fee % per side |
| `HIGH_FEE_THRESHOLD_PCT` | `15` | Soft-warn when round-trip fees exceed this % of risk |
| `DEFAULT_MIN_NOTIONAL` | `5.0` | Applied when a spec omits `minNotional` |
| `DEFAULT_CONTRACT_VALUE` | `1.0` | Applied when a spec omits `contractValue` |

---

## Project structure

```
.
├── server.js          # Express server: pure calculate() core + gates + routes
├── config.js          # Seed plan and fixed product constants
├── specs.json         # Contract specs — dropdown source (self-populating)
├── public/
│   ├── index.html     # UI markup
│   ├── app.js         # Client logic (mirrors server formatting)
│   └── styles.css     # GitHub-dark theme
└── package.json       # Node manifest (express)
```

### Data files

| File | Committed? | Notes |
|------|:---:|-------|
| `plan.json` | **No** (`.gitignore`) | Zoomex trading params; auto-seeded from `config.js` on first use |
| `hyperliquid-plan.json` | **No** (`.gitignore`) | Separate Hyperliquid trading params; auto-seeded from `config.js` on first use |
| `specs.json` | Yes | Contract specs; mutated at runtime as you add symbols |

---

## Scope

This is the **sizer core**: calculator + gates + editing the trading plan. It deliberately has **no** trade journal, P&L dashboard, daily/weekly caps, or kill switches. It makes no wallet or trading calls. Hyperliquid mode makes a read-only request to its public metadata API; the app stores plans and Zoomex specs on your own disk.

Nothing here is financial advice. Contract rules and fees can change; verify them on the exchange before trading. The calculator does not place orders.
