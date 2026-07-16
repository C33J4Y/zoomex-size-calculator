#!/usr/bin/env python3
"""
Zoomex (Bybit engine) USDT-margined perpetual position-sizing calculator.

One honest question: given a FIXED dollar risk and a STRUCTURALLY-placed stop,
how many contracts do I buy? SIZE is the OUTPUT. STOP is the INPUT. Never reversed.

Stdlib only. Run:  python3 zoomex_calc.py --help
"""

import argparse
import json
import math
import os
import sys

# Files live next to this script so the tool is portable / self-contained.
HERE = os.path.dirname(os.path.abspath(__file__))
PLAN_PATH = os.path.join(HERE, "plan.json")
SPECS_PATH = os.path.join(HERE, "specs.json")

DEFAULT_PLAN = {
    "account": 200.00,
    "risk": 50.00,
    "leverage": 10,
    "margin_mode_required": "isolated",
}


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------
def load_plan():
    """Load plan.json; create it with defaults on first run if missing."""
    if not os.path.exists(PLAN_PATH):
        save_plan(DEFAULT_PLAN)
        print("plan.json not found — created with defaults "
              "(account=200, risk=50, leverage=10, isolated).")
    with open(PLAN_PATH, "r") as f:
        c = json.load(f)
    # Backfill any missing keys so an old/partial file still works.
    for k, v in DEFAULT_PLAN.items():
        c.setdefault(k, v)
    return c


def save_plan(plan):
    with open(PLAN_PATH, "w") as f:
        json.dump(plan, f, indent=2)


def load_specs():
    if not os.path.exists(SPECS_PATH):
        return {}
    with open(SPECS_PATH, "r") as f:
        return json.load(f)


def save_specs(specs):
    with open(SPECS_PATH, "w") as f:
        json.dump(specs, f, indent=2)


# ---------------------------------------------------------------------------
# Formatting / small math helpers
# ---------------------------------------------------------------------------
def fmt_price(x):
    """Print prices without trailing-zero noise but with enough precision."""
    s = ("%.10f" % x).rstrip("0").rstrip(".")
    return s if s else "0"


def fmt_qty(x):
    if x == int(x):
        return str(int(x))
    return ("%.10f" % x).rstrip("0").rstrip(".")


def consecutive_losses_to_halve(account, risk):
    """
    How many consecutive full-risk losers (compounding on the running balance)
    drive the account to half or below.  0.75^n <= 0.5  ->  n = ceil(...).

    NOTE: the build spec wrote this as floor( ln(0.5)/ln(1-risk/account) ), but
    floor undercounts: at 25% risk that yields 2, while 0.75^2 = 0.5625 is still
    ABOVE half — it actually takes 3 losers to cross below. We use ceil so the
    printed number is the honest "losses to reach half," matching the spec's own
    stated "~3 at $50 on $200." This is the one deliberate deviation from the
    literal formula, made so the displayed risk truth is correct.
    """
    if risk <= 0 or account <= 0 or risk >= account:
        return 0
    return math.ceil(math.log(0.5) / math.log(1.0 - risk / account))


def stop_window(account, risk, leverage):
    """Tradeable stop window as fractions of entry price."""
    floor_pct = risk / (account * leverage)   # tighter -> position too big for margin
    ceiling_pct = 1.0 / leverage              # wider -> liquidation before stop
    return floor_pct, ceiling_pct


def print_acknowledgment(plan):
    """Standing risk acknowledgment printed on every sizing run."""
    account = plan["account"]
    risk = plan["risk"]
    risk_pct = (risk / account) * 100.0 if account else 0.0
    halve = consecutive_losses_to_halve(account, risk)
    print("--- standing acknowledgment ---")
    print("Risk per trade:    $%.2f on $%.2f account = %.1f%%" % (risk, account, risk_pct))
    print("Consecutive losses to halve account: ~%d" % halve)
    print("-------------------------------")


# ---------------------------------------------------------------------------
# Spec resolution (self-populating)
# ---------------------------------------------------------------------------
def prompt_positive_float(label, allow_blank_default=None):
    while True:
        raw = input(label).strip()
        if raw == "" and allow_blank_default is not None:
            return allow_blank_default
        try:
            val = float(raw)
        except ValueError:
            print("  Not a number. Try again.")
            continue
        if val <= 0:
            print("  Must be a positive number. Try again.")
            continue
        return val


def get_spec(symbol, specs):
    """Return spec dict for symbol, prompting interactively if unknown."""
    if symbol in specs:
        spec = specs[symbol]
        status = "saved/verified" if spec.get("verified") else "saved/UNVERIFIED"
        if not spec.get("verified"):
            print("REMINDER: spec for %s is UNVERIFIED — confirm on the Zoomex "
                  "contract-detail panel before the first trade." % symbol)
        return spec, status

    # Unknown symbol -> never guess. Prompt, validate, save as unverified.
    print("No saved spec for %s. Enter the contract spec (from Zoomex)." % symbol)
    min_qty = prompt_positive_float("  minQty: ")
    qty_step = prompt_positive_float("  qtyStep: ")
    min_notional = prompt_positive_float("  minNotional (blank = 5.0): ", allow_blank_default=5.0)
    contract_value = prompt_positive_float("  contractValue (blank = 1): ", allow_blank_default=1.0)
    spec = {
        "minQty": min_qty,
        "qtyStep": qty_step,
        "minNotional": min_notional,
        "contractValue": contract_value,
        "verified": False,
    }
    specs[symbol] = spec
    save_specs(specs)
    print("Saved %s as UNVERIFIED — confirm on Zoomex before the first trade." % symbol)
    return spec, "saved/UNVERIFIED"


# ---------------------------------------------------------------------------
# Plan amendment flow
# ---------------------------------------------------------------------------
def edit_plan(plan):
    print("=== EDIT TRADING PLAN ===")
    print("Current plan:")
    print("  account:   $%.2f" % plan["account"])
    print("  risk:      $%.2f" % plan["risk"])
    print("  leverage:  %sx" % plan["leverage"])
    print("  margin_mode_required: %s" % plan["margin_mode_required"])
    print("Enter new values (blank = keep current).")

    def ask(label, current, cast):
        raw = input("%s [%s]: " % (label, current)).strip()
        if raw == "":
            return current
        try:
            val = cast(raw)
        except ValueError:
            print("  Invalid — keeping current %s." % current)
            return current
        if val <= 0:
            print("  Must be positive — keeping current %s." % current)
            return current
        return val

    new_account = ask("account", plan["account"], float)
    new_risk = ask("risk", plan["risk"], float)
    new_leverage = ask("leverage", plan["leverage"], int)

    # --- CONSEQUENCES preview (shown BEFORE saving) ---
    risk_pct = (new_risk / new_account) * 100.0
    halve = consecutive_losses_to_halve(new_account, new_risk)
    floor_pct, ceiling_pct = stop_window(new_account, new_risk, new_leverage)
    print("--- consequences of the proposed plan ---")
    print("  account:   $%.2f" % new_account)
    print("  risk:      $%.2f" % new_risk)
    print("  leverage:  %sx" % new_leverage)
    print("  risk as %% of account: %.1f%%" % risk_pct)
    print("  consecutive losses to halve account: ~%d" % halve)
    print("  new tradeable stop window: %.2f%% – %.2f%%"
          % (floor_pct * 100.0, ceiling_pct * 100.0))
    print("--------------------------------------------")

    confirm = input("Write these values to plan.json? (y/N): ").strip().lower()
    if confirm == "y":
        plan["account"] = float(new_account)
        plan["risk"] = float(new_risk)
        plan["leverage"] = int(new_leverage)
        save_plan(plan)
        print("Plan amended and saved.")
    else:
        print("Aborted — plan unchanged.")


# ---------------------------------------------------------------------------
# Core sizing
# ---------------------------------------------------------------------------
def refuse(msg):
    print("REFUSED: " + msg)
    return 1


def size_trade(plan, specs, symbol, direction, entry, stop, margin_mode):
    account = plan["account"]
    risk = plan["risk"]
    leverage = plan["leverage"]
    required_mode = plan.get("margin_mode_required", "isolated")

    print_acknowledgment(plan)

    # GATE 1: margin mode — hard gate BEFORE any math.
    # Under cross the whole account backstops the position; a gap through the
    # stop realizes a loss capped at the ACCOUNT, not the risk budget. That
    # breaks the only promise this tool makes, so refuse outright.
    if margin_mode.lower() != required_mode.lower():
        return refuse("margin_mode=%s but plan requires %s. Under cross the whole "
                      "account backstops the position and the stop no longer caps the "
                      "loss at the risk budget. Set isolated and try again."
                      % (margin_mode, required_mode))

    # Resolve contract spec (may prompt for unknown symbols).
    spec, spec_status = get_spec(symbol, specs)
    min_qty = spec["minQty"]
    qty_step = spec["qtyStep"]
    min_notional = spec["minNotional"]

    # GATE 2: direction / stop consistency. Long stops below entry, short above.
    direction = direction.lower()
    if direction not in ("long", "short"):
        return refuse("direction must be long or short.")
    if direction == "long" and not (stop < entry):
        return refuse("LONG requires stop (%s) BELOW entry (%s)."
                      % (fmt_price(stop), fmt_price(entry)))
    if direction == "short" and not (stop > entry):
        return refuse("SHORT requires stop (%s) ABOVE entry (%s)."
                      % (fmt_price(stop), fmt_price(entry)))

    stop_distance = abs(entry - stop)
    if stop_distance <= 0:
        return refuse("stop distance must be greater than zero.")

    # --- The math (linear USDT perpetuals) ---
    raw_qty = risk / stop_distance                      # base units the budget buys
    qty = math.floor(raw_qty / qty_step) * qty_step     # round DOWN to a valid step
    # Clean up float fuzz from the step multiply.
    qty = round(qty, 10)

    position_value = qty * entry                        # notional USDT
    margin_required = position_value / leverage
    actual_risk = qty * stop_distance                   # true risk after rounding (<= risk)
    liq_pct = 1.0 / leverage                            # ~10% adverse at 10x (approx)
    if direction == "long":
        liq_price = entry * (1.0 - liq_pct)
    else:
        liq_price = entry * (1.0 + liq_pct)
    stop_pct = stop_distance / entry

    floor_pct, ceiling_pct = stop_window(account, risk, leverage)
    inside_window = floor_pct <= stop_pct <= ceiling_pct

    # GATE 3: qty must clear the exchange minimum. NEVER round up to reach it.
    if qty < min_qty:
        return refuse("computed qty %s < exchange minQty %s — untradeable at this "
                      "risk/account size. The structural stop is too wide for the "
                      "budget. (raw_qty=%s)"
                      % (fmt_qty(qty), fmt_qty(min_qty), fmt_qty(raw_qty)))

    # GATE 4: notional floor.
    if position_value < min_notional:
        return refuse("position value $%.4f < minNotional $%.2f — untradeable."
                      % (position_value, min_notional))

    # GATE 5: margin must fit the account. Tighter stop = bigger position = more margin.
    if margin_required > account:
        print("REFUSED: margin required $%.2f EXCEEDS account $%.2f." % (margin_required, account))
        print("  The stop is too TIGHT for this account: a tighter stop means a bigger")
        print("  position, which needs more margin than you have. Options:")
        print("    - widen the stop (place it at the next structural level out), or")
        print("    - lower risk via:  python3 zoomex_calc.py --edit-plan, or")
        print("    - raise leverage (accepting the closer liquidation).")
        print("  Tradeable stop window for this plan: %.2f%% – %.2f%%  (this stop: %.2f%%)"
              % (floor_pct * 100.0, ceiling_pct * 100.0, stop_pct * 100.0))
        return 1

    # GATE 6: liquidation sanity — warn loudly if the stop sits beyond liquidation.
    warnings = []
    if stop_pct > liq_pct:
        warnings.append(
            "!! DANGER: stop distance %.2f%% is WIDER than liquidation distance %.2f%%.\n"
            "   The position liquidates BEFORE the stop is hit. Under isolated margin the\n"
            "   loss becomes the committed margin ($%.2f) — more than the intended risk,\n"
            "   though still capped below the account. The stop never gets to act."
            % (stop_pct * 100.0, liq_pct * 100.0, margin_required)
        )

    # --- Output block ---
    risk_pct_acct = (risk / account) * 100.0
    halve = consecutive_losses_to_halve(account, risk)
    base = symbol.replace("USDT", "")

    print("=== ZOOMEX POSITION SIZE ===")
    print("Symbol:            %s   (spec: %s)" % (symbol, spec_status))
    print("Direction:         %s" % direction.upper())
    print("Entry:             $%s" % fmt_price(entry))
    print("Stop:              $%s" % fmt_price(stop))
    print("Stop distance:     $%s  (%.2f%%)" % (fmt_price(stop_distance), stop_pct * 100.0))
    print("Tradeable window:  %.2f%% – %.2f%%   [this trade: %s]"
          % (floor_pct * 100.0, ceiling_pct * 100.0, "inside" if inside_window else "OUTSIDE"))
    print("---")
    print("Contracts (qty):   %s %s" % (fmt_qty(qty), base))
    print("Position value:    $%.2f" % position_value)
    print("Margin required:   $%.2f  (at %sx)" % (margin_required, leverage))
    print("---")
    print("Intended risk:     $%.2f" % risk)
    print("Actual risk:       $%.2f   (after rounding to step)" % actual_risk)
    print("Liquidation est:   ~$%s  (%.2f%% from entry)" % (fmt_price(liq_price), liq_pct * 100.0))
    print("---")
    print("Account:           $%.2f" % account)
    print("Risk as %% account: %.1f%%" % risk_pct_acct)
    print("Consecutive losses to halve account: ~%d" % halve)
    for w in warnings:
        print(w)
    print("=== END ===")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        description="Zoomex USDT-perp position sizer. SIZE is the output; STOP is the input.")
    p.add_argument("--edit-plan", action="store_true",
                   help="Interactively edit account/risk/leverage (shows consequences first).")
    p.add_argument("--symbol", help="Contract symbol, e.g. ONDOUSDT")
    p.add_argument("--direction", choices=["long", "short"], help="Trade direction")
    p.add_argument("--entry", type=float, help="Entry price")
    p.add_argument("--stop", type=float, help="Structural stop price")
    p.add_argument("--margin-mode", dest="margin_mode",
                   help="Declared margin mode for the trade (must be isolated)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    plan = load_plan()

    if args.edit_plan:
        edit_plan(plan)
        return 0

    specs = load_specs()

    # Sizing run: all per-trade inputs required.
    missing = [name for name, val in (
        ("--symbol", args.symbol),
        ("--direction", args.direction),
        ("--entry", args.entry),
        ("--stop", args.stop),
        ("--margin-mode", args.margin_mode),
    ) if val is None]
    if missing:
        print("Missing required input(s): %s" % ", ".join(missing))
        print("Per-trade inputs are: symbol, direction, entry, stop, margin_mode.")
        print("account / risk / leverage come from plan.json "
              "(change them only via --edit-plan).")
        return 2

    return size_trade(plan, specs, args.symbol.upper(), args.direction,
                      args.entry, args.stop, args.margin_mode)


if __name__ == "__main__":
    sys.exit(main())
