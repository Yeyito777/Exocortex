#!/usr/bin/env bash
# check-ipv6.sh — Detect broken IPv6 that causes bun install to hang.
#
# Exit 0: safe to run bun install
# Exit 1: broken IPv6 detected — bun install will hang
#
# See: https://github.com/<repo>/issues/3
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

REGISTRY="registry.npmjs.org"
GAI_FIX="precedence ::ffff:0:0/96  100"

# ── Step 1: Is the gai.conf IPv4-preference fix already applied? ─────
# If so, the OS will prefer IPv4 and bun install won't hang.

if grep -qsE '^\s*precedence\s+::ffff:0:0/96' /etc/gai.conf 2>/dev/null; then
    exit 0
fi

# ── Step 2: Do we even have a global IPv6 address? ───────────────────
# If not, the kernel will immediately fail IPv6 connections (no hang).

if ! ip -6 addr show scope global 2>/dev/null | grep -q 'inet6'; then
    # No global IPv6 — bun won't get stuck, IPv6 connections fail fast
    exit 0
fi

# ── Step 3: Does the npm registry resolve to IPv6? ───────────────────

if ! getent ahostsv6 "$REGISTRY" 2>/dev/null | grep -q 'STREAM'; then
    # Registry doesn't resolve to AAAA — no IPv6 connection attempt
    exit 0
fi

# ── Step 4: Can we actually connect over IPv6? ───────────────────────
# This is the critical test. If IPv6 is present but broken,
# this will time out (SYN sent, no SYN-ACK received).

if curl -6 --max-time 3 -sf -o /dev/null "https://$REGISTRY/" 2>/dev/null; then
    # IPv6 works fine
    exit 0
fi

# ── Step 5: Confirm IPv4 works (so we know it's specifically IPv6) ───

if ! curl -4 --max-time 5 -sf -o /dev/null "https://$REGISTRY/" 2>/dev/null; then
    # Neither works — probably a general network issue, not IPv6-specific
    printf "${YELLOW}${BOLD}⚠ Warning:${NC} Cannot reach %s over IPv4 or IPv6.\n" "$REGISTRY"
    printf "  Check your network connection.\n"
    exit 1
fi

# ── Broken IPv6 detected ────────────────────────────────────────────

printf "\n"
printf "${RED}${BOLD}✗ Broken IPv6 connectivity detected${NC}\n"
printf "\n"
printf "  Your system has a global IPv6 address but cannot connect to\n"
printf "  %s over IPv6. This will cause ${BOLD}bun install${NC} to hang\n" "$REGISTRY"
printf "  indefinitely (Bun does not fall back to IPv4).\n"
printf "\n"
printf "  ${BOLD}Fix:${NC} Tell your system to prefer IPv4 by running:\n"
printf "\n"
printf "    ${GREEN}sudo sh -c 'echo \"${GAI_FIX}\" >> /etc/gai.conf'${NC}\n"
printf "\n"
printf "  This is safe — it makes all programs prefer IPv4 when available,\n"
printf "  which is the correct behavior when IPv6 is non-functional.\n"
printf "\n"
printf "  After applying the fix, re-run ${BOLD}make install${NC}.\n"
printf "  See: https://github.com/yeyito/Exocortex/issues/3\n"
printf "\n"
exit 1

