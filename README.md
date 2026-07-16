# Zoomex Position Sizer

Localhost-only position-sizing tool for **Zoomex (Bybit engine) USDT-margined
alt perpetuals** — the speculative alt sleeve (ONDO, HYPE, USELESS, and whatever
rotates next). It answers one question honestly: given a fixed dollar risk and a
**structurally-placed stop**, how many contracts do I buy?

**SIZE is the output. STOP is the input. Never the reverse.** There is no
"size-first" mode and no override button — that inversion is how accounts die.

This ships in two forms that share the same `plan.json` and `specs.json`:

- **`zoomex_calc.py`** — the original command-line calculator (Python 3, stdlib only).
- **Web app** (`server.js` + `public/`) — a browser UI mirroring the BTC sizing
  calculator's stack and look (Node + Express, vanilla JS, GitHub-dark theme).

## Run the web app

```
npm install      # Node 18+
npm start        # serves http://localhost:3001 (loopback only)
```

Defaults to **3001** so it can run alongside the BTC sizing calculator (which
uses 3000). Override with `PORT=NNNN npm start`.

## What it enforces (the six gates)

Hard refusals (no contract count shown):

1. **Margin mode** — plan requires `isolated`; declaring `cross` refuses
   before any math. Under cross the whole account backstops the position and the
   stop no longer caps the loss at the risk budget.
2. **Direction / stop** — long needs stop below entry, short needs stop above.
3. **qty ≥ minQty** — a stop so wide that size falls below the exchange minimum is
   untradeable. Never rounded up.
4. **position value ≥ minNotional**.
5. **margin ≤ account** — too-tight stop ⇒ bigger position ⇒ more margin than the
   account holds. Widen the stop, lower risk, or raise leverage.

Loud warning (still sizes):

6. **Liquidation before stop** — if stop distance exceeds the liquidation distance
   (`1 / leverage`), the position liquidates before the stop acts.

## Profit target & fees

An optional **Target price** reports the reward side — it does **not** drive size
(size comes only from risk + stop; there is no "size to a profit target" mode).

Fees are modeled like the reference BTC calculator: the position is **sized
against net loss INCLUDING round-trip taker fees**, so being stopped out — fees
and all — costs the risk budget and no more. The result separates:

- **Gross loss at stop** (price move only) vs **Net loss at stop** (all-in, ≤ budget).
- **Gross profit / R:R** vs **Net profit / R:R** (after round-trip fees), plus the
  **break-even win rate**.

The **Taker fee % (per side)** defaults to `0.06` (config `DEFAULT_TAKER_FEE_PCT`)
and assumes taker on both entry and exit — the worst case. Lower it if you enter
as a maker; set it to `0` to reproduce pure gross sizing. Round-trip fees above
`HIGH_FEE_THRESHOLD_PCT` (15%) of the risk budget raise a soft warning.

## The plan

`plan.json` holds `account`, `risk`, `leverage`, `margin_mode_required`. These
are **fixed for the session** — risk is not a knob to spin on a feeling. The only
way to change them is the **Edit trading plan** flow, which shows the consequences
(risk as % of account, consecutive losses to halve the account, and the new
tradeable stop window) **before** you confirm. `margin_mode_required` stays
`isolated` and is not a UI knob.

> The "consecutive losses to halve account" figure uses `ceil(ln 0.5 / ln(1 −
> risk/account))` — the honest count of losses needed to reach half (3 at the
> default $50/$200). The original CLI spec wrote `floor`, which undercounts; the
> web app and CLI both use `ceil` and document the deviation in code.

## Contract specs

The **Symbol** field is a dropdown built from `specs.json`, which ships three
verified symbols (ONDOUSDT, HYPEUSDT, USELESSUSDT). Choose **➕ New symbol…** to
add a coin that isn't saved: type the symbol and its contract spec (minQty /
qtyStep / minNotional / contractValue) from the Zoomex contract panel, then
**Save symbol to dropdown** to persist it to `specs.json` (stored `verified:false`
until you confirm it). Saved symbols then appear in the dropdown on every load.
This mirrors the Python CLI's self-populating specs.

## Routes

- `GET  /api/plan` — current plan + standing acknowledgment + tradeable window.
- `GET  /api/specs` — known contract specs (the dropdown source).
- `POST /api/specs` — save a symbol's spec to `specs.json` (stored `verified:false`).
- `POST /api/calculate` — pure sizing calc; never writes anything.
- `POST /api/plan/preview` — consequences of a proposed plan (no write).
- `POST /api/plan/amend` — commit a new plan. Requires `{ "confirm": true }`.

## Scope

This is the **sizer core**: calculator + gates + editing the trading plan. No trade
journal, no P&L dashboard, no daily/weekly caps or kill switches — those belong to
the BTC rebuild calculator, not this alt sleeve, and aren't invented here.
