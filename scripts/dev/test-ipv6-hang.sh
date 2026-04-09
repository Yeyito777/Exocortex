#!/usr/bin/env bash
# test-ipv6-hang.sh — Reproduce & test fixes for the bun install IPv6 hang (issue #3)
#
# Simulates "IPv6 present but broken" by:
#   1. Adding a global IPv6 address + default route (so the system attempts IPv6)
#   2. Using ip6tables to DROP outgoing TCP/443 (simulates blackholed packets)
#
# Then runs three phases:
#   Phase 1: Confirms bun install hangs (bug reproduced)
#   Phase 2: Applies the gai.conf workaround and confirms bun install works
#   Phase 3: Tests the pre-flight check script detects the issue
#
# Requires: sudo (passwordless recommended), bun, curl, ip6tables
# Usage: sudo bash scripts/dev/test-ipv6-hang.sh
set -euo pipefail

IFACE="enp7s0"
FAKE_ADDR="2001:db8::1/64"
FAKE_GW="2001:db8::ffff"
GAI_CONF="/etc/gai.conf"
GAI_FIX_LINE="precedence ::ffff:0:0/96  100"
TIMEOUT_SECS=15
REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${BOLD}[INFO]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
fail()  { printf "${RED}[FAIL]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
header(){ printf "\n${BOLD}══════ %s ══════${NC}\n\n" "$*"; }

# ── State tracking ───────────────────────────────────────────────────

IPV6_ADDED=false
IP6TABLES_ADDED=false
GAI_MODIFIED=false
GAI_BACKUP=""
TEST_DIR=""

cleanup() {
    info "Cleaning up..."

    # Remove ip6tables DROP rule
    if $IP6TABLES_ADDED; then
        ip6tables -D OUTPUT -p tcp --dport 443 -j DROP 2>/dev/null || true
        ok "Removed ip6tables DROP rule"
    fi

    # Remove fake IPv6
    if $IPV6_ADDED; then
        ip -6 route del default via "$FAKE_GW" dev "$IFACE" 2>/dev/null || true
        ip -6 addr del "$FAKE_ADDR" dev "$IFACE" 2>/dev/null || true
        ok "Removed fake IPv6 config"
    fi

    # Restore gai.conf
    if $GAI_MODIFIED && [[ -n "$GAI_BACKUP" ]]; then
        cp "$GAI_BACKUP" "$GAI_CONF"
        rm -f "$GAI_BACKUP"
        ok "Restored original gai.conf"
    fi

    # Clean temp dir
    [[ -n "$TEST_DIR" ]] && rm -rf "$TEST_DIR"

    echo ""
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────

setup_broken_ipv6() {
    # Add a global IPv6 address so the system will attempt IPv6 connections
    ip -6 addr add "$FAKE_ADDR" dev "$IFACE" 2>/dev/null || true
    ip -6 route add default via "$FAKE_GW" dev "$IFACE" 2>/dev/null || true
    IPV6_ADDED=true

    # DROP all outgoing IPv6 TCP/443 — this simulates the blackhole perfectly:
    # SYN packets are silently dropped, connections stall in SYN-SENT forever
    ip6tables -I OUTPUT -p tcp --dport 443 -j DROP 2>/dev/null || true
    IP6TABLES_ADDED=true
}

teardown_broken_ipv6() {
    if $IP6TABLES_ADDED; then
        ip6tables -D OUTPUT -p tcp --dport 443 -j DROP 2>/dev/null || true
        IP6TABLES_ADDED=false
    fi
    if $IPV6_ADDED; then
        ip -6 route del default via "$FAKE_GW" dev "$IFACE" 2>/dev/null || true
        ip -6 addr del "$FAKE_ADDR" dev "$IFACE" 2>/dev/null || true
        IPV6_ADDED=false
    fi
}

apply_gai_fix() {
    GAI_BACKUP=$(mktemp)
    cp "$GAI_CONF" "$GAI_BACKUP"
    echo "$GAI_FIX_LINE" >> "$GAI_CONF"
    GAI_MODIFIED=true
}

restore_gai() {
    if $GAI_MODIFIED && [[ -n "$GAI_BACKUP" ]]; then
        cp "$GAI_BACKUP" "$GAI_CONF"
        rm -f "$GAI_BACKUP"
        GAI_BACKUP=""
        GAI_MODIFIED=false
    fi
}

make_test_project() {
    TEST_DIR=$(mktemp -d)
    cat > "$TEST_DIR/package.json" << 'EOF'
{
  "name": "ipv6-hang-test",
  "dependencies": {
    "is-number": "^7.0.0"
  }
}
EOF
}

run_bun_install() {
    local dir="$1"
    local label="$2"
    local start end elapsed exit_code

    # Clean local state
    rm -rf "$dir/node_modules" "$dir/bun.lock" 2>/dev/null || true

    info "Running bun install ($label, timeout ${TIMEOUT_SECS}s)..."
    start=$(date +%s%N)
    set +e
    timeout "$TIMEOUT_SECS" "$BUN" install --no-cache --cwd "$dir" 2>&1
    exit_code=$?
    set -e
    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))

    echo "  → exit=$exit_code elapsed=${elapsed}ms"
    return $exit_code
}

# ── Preflight ────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
    fail "Must run as root (sudo)"
    exit 1
fi

BUN=$(command -v bun 2>/dev/null || echo "/home/yeyito/.local/bun/bin/bun")
[[ -x "$BUN" ]] || { fail "bun not found"; exit 1; }

info "bun: $BUN ($("$BUN" --version))"
info "Interface: $IFACE"

# Verify baseline IPv4 works
if ! curl -4 --max-time 5 -sf https://registry.npmjs.org/ > /dev/null; then
    fail "IPv4 to registry.npmjs.org doesn't work — can't test"
    exit 1
fi
ok "IPv4 baseline works"

# ═════════════════════════════════════════════════════════════════════
header "PHASE 1: Reproduce the bug"
# ═════════════════════════════════════════════════════════════════════

setup_broken_ipv6
ok "Broken IPv6 simulated (global addr + ip6tables DROP on tcp/443)"

# Sanity check: confirm IPv6 hangs and IPv4 works
info "Verifying IPv6 hangs..."
if timeout 5 curl -6 --max-time 5 -sf https://registry.npmjs.org/ > /dev/null 2>&1; then
    fail "IPv6 unexpectedly worked — simulation failed"
    exit 1
fi
ok "IPv6 hangs as expected"

info "Verifying IPv4 still works..."
if ! curl -4 --max-time 5 -sf https://registry.npmjs.org/ > /dev/null; then
    fail "IPv4 broken — aborting"
    exit 1
fi
ok "IPv4 still works"

make_test_project

PHASE1_PASS=false
if run_bun_install "$TEST_DIR" "broken IPv6, no fix"; then
    fail "PHASE 1: bun install succeeded — bug NOT reproduced"
else
    EXIT=$?
    if [[ $EXIT -eq 124 ]]; then
        ok "PHASE 1 PASSED: bun install hung for ${TIMEOUT_SECS}s and was killed"
        PHASE1_PASS=true
    else
        warn "PHASE 1: bun install failed (exit $EXIT) but didn't hang — partial reproduction"
    fi
fi

# ═════════════════════════════════════════════════════════════════════
header "PHASE 2: Test gai.conf workaround"
# ═════════════════════════════════════════════════════════════════════

info "Applying gai.conf fix: $GAI_FIX_LINE"
apply_gai_fix
ok "gai.conf updated — system now prefers IPv4"

PHASE2_PASS=false
if run_bun_install "$TEST_DIR" "broken IPv6 + gai.conf fix"; then
    ok "PHASE 2 PASSED: bun install succeeded with gai.conf workaround"
    PHASE2_PASS=true
else
    fail "PHASE 2: bun install still failed/hung even with gai.conf fix"
fi

# Restore gai.conf for phase 3
restore_gai
ok "Restored gai.conf"

# ═════════════════════════════════════════════════════════════════════
header "PHASE 3: Test pre-flight detection script"
# ═════════════════════════════════════════════════════════════════════

PREFLIGHT="$REPO_DIR/scripts/setup/check-ipv6.sh"
PHASE3_PASS=false

if [[ -x "$PREFLIGHT" ]]; then
    info "Running pre-flight check with broken IPv6..."
    set +e
    "$PREFLIGHT" 2>&1
    PREFLIGHT_EXIT=$?
    set -e

    if [[ $PREFLIGHT_EXIT -ne 0 ]]; then
        ok "Pre-flight correctly detected broken IPv6 (exit $PREFLIGHT_EXIT)"
    else
        fail "Pre-flight didn't detect broken IPv6"
    fi

    # Now remove the broken IPv6 and check it passes clean
    teardown_broken_ipv6
    info "Running pre-flight check with clean network..."
    set +e
    "$PREFLIGHT" 2>&1
    PREFLIGHT_EXIT_CLEAN=$?
    set -e

    if [[ $PREFLIGHT_EXIT_CLEAN -eq 0 ]]; then
        ok "Pre-flight passes with clean network (exit 0)"
    else
        fail "Pre-flight still fails with clean network (exit $PREFLIGHT_EXIT_CLEAN)"
    fi

    # Both must pass
    if [[ $PREFLIGHT_EXIT -ne 0 && $PREFLIGHT_EXIT_CLEAN -eq 0 ]]; then
        ok "PHASE 3 PASSED: Pre-flight detection works correctly"
        PHASE3_PASS=true
    fi
else
    warn "PHASE 3 SKIPPED: $PREFLIGHT not found"
    warn "Create scripts/setup/check-ipv6.sh and re-run"
fi

# ═════════════════════════════════════════════════════════════════════
header "RESULTS"
# ═════════════════════════════════════════════════════════════════════

TOTAL=0
PASSED=0

for phase in PHASE1_PASS PHASE2_PASS PHASE3_PASS; do
    TOTAL=$((TOTAL + 1))
    if ${!phase}; then
        printf "  ${GREEN}✓${NC} %s\n" "$phase"
        PASSED=$((PASSED + 1))
    else
        if [[ "$phase" == "PHASE3_PASS" && ! -x "$PREFLIGHT" ]]; then
            printf "  ${YELLOW}○${NC} %s (skipped)\n" "$phase"
            TOTAL=$((TOTAL - 1))
        else
            printf "  ${RED}✗${NC} %s\n" "$phase"
        fi
    fi
done

echo ""
if [[ $PASSED -eq $TOTAL ]]; then
    printf "${GREEN}${BOLD}All $TOTAL tests passed!${NC}\n"
    exit 0
else
    printf "${YELLOW}${BOLD}$PASSED/$TOTAL tests passed${NC}\n"
    exit 1
fi
