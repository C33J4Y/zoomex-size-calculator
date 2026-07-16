# Zoomex Position Sizer

A localhost-only **position-sizing calculator** for [Zoomex](https://www.zoomex.com/) (Bybit-engine) USDT-margined alt perpetuals. It answers one question honestly:

> Given a fixed dollar risk and a **structurally-placed stop**, how many contracts do I buy?

**SIZE is the output. STOP is the input. Never the reverse.** There is no "size-first" mode and no override button — that inversion is how trading accounts die. You place your stop where market structure says it belongs; the tool tells you the largest position that keeps a stop-out inside your risk budget, or refuses if no valid size exists.

It ships in two forms that share the same `plan.json` and `specs.json`:

| Form | Entry point | Stack |
|------|-------------|-------|
| **Web app** | `server.js` + `public/` | Node + Express, vanilla JS, GitHub-dark theme |
| **CLI** | `zoomex_calc.py` | Python 3, standard library only |

---

## Quick start

### Web app

```bash
npm install        # Node 18+
npm start          # serves http://localhost:3001 (loopback only)
```

Open **http://localhost:3001**. The server binds to `127.0.0.1` only — it is not reachable from your network. It defaults to port **3001** so it can run alongside a companion BTC calculator on 3000; override with `PORT=NNNN npm start`.

### CLI

```bash
python3 zoomex_calc.py --symbol ONDOUSDT --direction long \
  --entry 0.3379 --stop 0.3278 --margin-mode isolated

python3 zoomex_calc.py --edit-plan        # change account/risk/leverage (shows consequences first)
python3 zoomex_calc.py --help
```

No dependencies, no build step — just Python 3.

---

## How sizing works

For a linear USDT-margined perpetual, the loss per contract if price hits your stop is the price move **plus round-trip taker fees**. Sizing against that all-in loss caps a stop-out at your risk budget and no more:

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

**Fees.** The default **taker fee** is `0.06%` per side (`DEFAULT_TAKER_FEE_PCT`), assuming taker on **both** entry and exit (worst case). Lower it if you enter as a maker; set it to `0` to reproduce pure gross sizing. Results separate **gross** (price move only) from **net** (all-in, ≤ budget) on both the loss and profit sides. Round-trip fees above `HIGH_FEE_THRESHOLD_PCT` (15%) of the risk budget raise a soft warning.

**Profit target.** An optional target price reports the reward side — **gross/net profit, R:R, and break-even win rate**. It does **not** drive size; size comes only from risk + stop. There is no "size to a profit target" mode.

---

## The trading plan

`plan.json` holds the four values that are **fixed for a session**:

```json
{
  "account": 200,
  "risk": 50,
  "leverage": 10,
  "margin_mode_required": "isolated"
}
```

Risk is not a knob to spin mid-trade on a feeling. The only way to change `account` / `risk` / `leverage` is the **Edit trading plan** flow (web) or `--edit-plan` (CLI), which shows the consequences — risk as % of account, consecutive losses to halve the account, and the new tradeable stop window — **before** you confirm. `margin_mode_required` stays `isolated` and is not a UI knob.

> **Note:** `plan.json` is **not committed** — it holds personal trading parameters and is auto-created from the `DEFAULT_PLAN` seed in `config.js` on first run. See [Data files](#data-files).

> The "consecutive losses to halve account" figure uses `ceil(ln 0.5 / ln(1 − risk/account))` — the honest count of losses to reach half (3 at the default $50/$200). An earlier spec used `floor`, which undercounts; both the web app and CLI use `ceil` and document the deviation in code.

---

## Contract specs

`specs.json` is the source for the **Symbol** dropdown, mapping each symbol to its contract spec:

```json
"ONDOUSDT": { "minQty": 1, "qtyStep": 1, "minNotional": 5, "contractValue": 1, "verified": true }
```

Choose **➕ New symbol…** in the UI (or just pass an unknown `--symbol` in the CLI) to enter a spec from the Zoomex contract panel. Saved symbols are stored `verified: false` until you confirm them, and appear in the dropdown on every load. This file is **self-populating** — the app writes to it as you add symbols.

---

## HTTP API

All routes are served from `http://localhost:3001`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET`  | `/api/plan` | Current plan + standing acknowledgment + tradeable window |
| `GET`  | `/api/specs` | Known contract specs (the dropdown source) |
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
├── zoomex_calc.py     # Standalone Python CLI (stdlib only)
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
| `plan.json` | **No** (`.gitignore`) | Personal trading params; auto-seeded from `config.js` on first run |
| `specs.json` | Yes | Contract specs; mutated at runtime as you add symbols |

---

## Scope

This is the **sizer core**: calculator + gates + editing the trading plan. It deliberately has **no** trade journal, P&L dashboard, daily/weekly caps, or kill switches. It makes no network calls and stores nothing beyond `plan.json` and `specs.json` on your own disk.

Nothing here is financial advice. Contract specs and fees change — always verify against the live Zoomex contract panel before trading.
