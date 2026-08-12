#!/usr/bin/env bash
#
# Static analysis runners. See docs/static-analysis.md for what each tool proves,
# how to install it, and the triage of every finding it currently reports.
#
# Usage: ./scripts/analyze.sh [circuit|lint|picus|ecne|slither|aderyn|contracts|all]
set -uo pipefail

PROTOCOL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$PROTOCOL/../.." && pwd)"
REPORTS="$PROTOCOL/docs/reports"
ECNE_HOME="${ECNE_HOME:-$HOME/tools/EcneProject}"
PICUS_HOME="${PICUS_HOME:-$HOME/tools/Picus}"
PICUS_SOLVER="${PICUS_SOLVER:-cvc5}"
mkdir -p "$REPORTS"

# Installed via `uv tool install` / prebuilt binary; neither lands on a login PATH.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/racket/bin:$PATH"

have() { command -v "$1" >/dev/null 2>&1 || { echo "!! $1 not found — see docs/static-analysis.md"; return 1; }; }

run_circuit() {
  have circomspect || return 1
  echo "== circomspect =="
  circomspect "$PROTOCOL/circuits/transact.circom" \
    --library "$ROOT/node_modules/circomlib/circuits" \
    2>&1 | tee "$REPORTS/circomspect.txt"
}

# The under-constrainedness check that actually decides something here.
#
# Picus is run per TEMPLATE, not on transact.r1cs, and that is the whole point. Both Picus
# and Ecne judge a circuit by whether its main component's *output* signals are uniquely
# determined; transact declares none (every public signal is an input), so the default
# verdict is `0 == 0` and means nothing. Picus's --strong mode targets every wire instead,
# which is sound but undecidable at 94k constraints — it returns "Cannot determine" with
# both z3 and cvc5. The templates in circuits/verify/ have real outputs and are small
# enough to decide, so --strong on each of them is a genuine result.
run_picus() {
  have racket || return 1
  [ -d "$PICUS_HOME" ] || { echo "!! Picus not at $PICUS_HOME — see docs/static-analysis.md"; return 1; }
  echo "== Picus (per template, strong mode) =="
  local out="$REPORTS/picus.txt"
  : > "$out"
  for f in "$PROTOCOL"/circuits/verify/*.circom; do
    local name; name="$(basename "$f" .circom)"
    local r1cs="$PROTOCOL/circuits/out/verify/$name.r1cs"
    if [ ! -f "$r1cs" ]; then
      circom "$f" --r1cs --sym -o "$PROTOCOL/circuits/out/verify" \
        -l "$ROOT/node_modules/circomlib/circuits" >/dev/null 2>&1 || {
          echo "$name: COMPILE FAILED" | tee -a "$out"; continue; }
    fi
    local verdict
    verdict="$( cd "$PICUS_HOME" && ./run-picus --strong --solver "$PICUS_SOLVER" \
                  --timeout 20000 "$r1cs" 2>&1 | grep -E "properly constrained|underconstrained|Cannot determine" | tail -1 )"
    printf '%-18s %s\n' "$name" "${verdict:-no verdict}" | tee -a "$out"
  done
  echo "-> $out"
}

run_ecne() {
  have julia || return 1
  local r1cs="$PROTOCOL/circuits/out/transact/transact.r1cs"
  [ -f "$r1cs" ] || { echo "!! $r1cs missing — run 'npm run circuits:compile' first"; return 1; }
  [ -d "$ECNE_HOME" ] || { echo "!! Ecne not at $ECNE_HOME — set ECNE_HOME or see docs/static-analysis.md"; return 1; }
  echo "== Ecne (minutes, not seconds) =="
  # Julia 1.8 specifically: Ecne's pinned deps use @_pure_meta, removed from current Base.
  # The full log carries a line per signal — tens of MB — so it stays out of the repo and
  # only the verdict is kept.
  local full="${TMPDIR:-/tmp}/ecne-transact.log"
  ( cd "$ECNE_HOME" && julia +1.8 --project=. src/Ecne.jl \
      --r1cs "$r1cs" --name transact --sym "$PROTOCOL/circuits/out/transact/transact.sym" ) \
    > "$full" 2>&1
  # The authoritative number is the "Solved for N variables out of M" line. The trailing
  # "has sound constraints" banner is VACUOUS on this circuit — its criterion is that every
  # main-component *output* is determined, and transact declares none. See
  # docs/static-analysis.md; do not report the banner as a result.
  {
    echo "Ecne — transact.r1cs — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    grep -E '^Solved for' "$full"
    echo "undetermined signals (expect 9, one 'inv' per IsZero-family component): $(grep -c '^constraint #' "$full")"
    echo
    echo "banner (vacuous — 0 output signals, see docs/static-analysis.md):"
    grep -E 'sound constraints|potentially unsound' "$full" | tail -2
  } > "$REPORTS/ecne.txt"
  cat "$REPORTS/ecne.txt"
  echo "(full log: $full)"
}

run_slither() {
  have slither || return 1
  echo "== Slither =="
  # From the repo root: foundry.toml lives there and slither compiles through Foundry.
  # Slither exits non-zero whenever it reports anything, so its status is not a pass/fail.
  ( cd "$ROOT" && slither packages/protocol \
      --filter-paths "mocks|TransactVerifier.sol|node_modules|forge-std|testFuzz|/lib/" \
      --exclude-informational --exclude-optimization \
      --checklist ) > "$REPORTS/slither.md" 2>"${TMPDIR:-/tmp}/slither.stderr.txt"
  grep -E '^ - \[' "$REPORTS/slither.md" | head -20
  echo "-> $REPORTS/slither.md"
}

run_aderyn() {
  have aderyn || return 1
  echo "== Aderyn =="
  ( cd "$ROOT" && aderyn --output "$REPORTS/aderyn.md" \
      --path-excludes "lib/,testFuzz/,mocks/,TransactVerifier.sol" . ) >/dev/null 2>&1
  sed -n '/^## Issue Summary/,/^# High/p' "$REPORTS/aderyn.md"
  echo "-> $REPORTS/aderyn.md"
}

case "${1:-all}" in
  circuit)   run_circuit; run_picus ;;
  lint)      run_circuit ;;
  picus)     run_picus ;;
  ecne)      run_ecne ;;
  slither)   run_slither ;;
  aderyn)    run_aderyn ;;
  contracts) run_slither; run_aderyn ;;
  all)       run_circuit; run_picus; run_ecne; run_slither; run_aderyn ;;
  *)         echo "usage: $0 [circuit|lint|picus|ecne|slither|aderyn|contracts|all]"; exit 2 ;;
esac
