# Exocortex — Makefile
#
# Usage:
#   make install     Install everything (deps, commands, systemd service)
#   make uninstall   Remove commands and systemd service
#   make windows     Cross-compile Windows executables to dist/

PREFIX    := $(HOME)/.local
BIN_DIR   := $(PREFIX)/bin
UNIT_DIR  := $(HOME)/.config/systemd/user
UNIT_NAME := exocortex-daemon.service
REPO_DIR  := $(CURDIR)

# ── Targets ──────────────────────────────────────────────────────────

.PHONY: install uninstall check-bun deps links service login \
        remove-links remove-service status windows clean-windows

install: check-bun deps links service
	@printf '\n  ✓ Exocortex installed.\n'
	@printf '    Commands: exocortexd, exocortex, exo\n'
	@printf '    Service:  exocortex-daemon.service (systemd user)\n\n'
	@printf '  Next steps:\n'
	@printf '    1. Ensure ~/.local/bin is in your PATH\n'
	@printf '    2. Run: exocortexd login\n'
	@printf '    3. Run: exocortex\n\n'

uninstall: remove-links remove-service
	@printf '\n  ✓ Exocortex uninstalled.\n\n'

# ── Prerequisites ────────────────────────────────────────────────────

check-bun:
	@command -v bun >/dev/null 2>&1 || { \
		printf '\n  ✗ bun is required but not found.\n'; \
		printf '    Install: curl -fsSL https://bun.sh/install | bash\n\n'; \
		exit 1; \
	}

# ── Dependencies ─────────────────────────────────────────────────────

deps:
	@bash $(REPO_DIR)/scripts/setup/check-ipv6.sh
	@printf '  Installing dependencies...\n'
	@bun install --frozen-lockfile
	@printf '  ✓ Dependencies installed\n'

# ── Symlinks ─────────────────────────────────────────────────────────

links:
	@mkdir -p $(BIN_DIR)
	@ln -sf $(REPO_DIR)/bin/exocortexd $(BIN_DIR)/exocortexd
	@ln -sf $(REPO_DIR)/bin/exocortex  $(BIN_DIR)/exocortex
	@ln -sf $(REPO_DIR)/bin/exo        $(BIN_DIR)/exo
	@printf '  ✓ Linked exocortexd, exocortex, exo → $(BIN_DIR)/\n'

remove-links:
	@rm -f $(BIN_DIR)/exocortexd $(BIN_DIR)/exocortex $(BIN_DIR)/exo
	@printf '  ✓ Removed symlinks from $(BIN_DIR)/\n'

# ── Systemd service ─────────────────────────────────────────────────

service:
	@UNIT_NAME=$(UNIT_NAME) bash $(REPO_DIR)/scripts/setup/install-daemon.sh

remove-service:
	@if systemctl --user is-active --quiet $(UNIT_NAME) 2>/dev/null; then \
		systemctl --user stop $(UNIT_NAME); \
		printf '  ✓ Stopped $(UNIT_NAME)\n'; \
	fi
	@if [ -f $(UNIT_DIR)/$(UNIT_NAME) ]; then \
		systemctl --user disable $(UNIT_NAME) 2>/dev/null || true; \
		rm -f $(UNIT_DIR)/$(UNIT_NAME); \
		systemctl --user daemon-reload; \
		printf '  ✓ Removed $(UNIT_NAME)\n'; \
	fi

# ── Utilities ────────────────────────────────────────────────────────

status:
	@systemctl --user status $(UNIT_NAME) --no-pager

login:
	@cd $(REPO_DIR)/daemon && bun run src/main.ts login

# ── Windows cross-compilation ────────────────────────────────────

DIST_DIR := $(REPO_DIR)/dist

windows: check-bun
	@mkdir -p $(DIST_DIR)
	@printf '  Building Windows executables...\n'
	@bun build --compile --target=bun-windows-x64 daemon/src/main.ts --outfile $(DIST_DIR)/exocortexd.exe
	@bun build --compile --target=bun-windows-x64 tui/src/main.ts --outfile $(DIST_DIR)/exocortex.exe
	@bun build --compile --target=bun-windows-x64 external-tools/exo-cli/src/main.ts --outfile $(DIST_DIR)/exo.exe
	@cp $(REPO_DIR)/scripts/exocortex.bat $(DIST_DIR)/exocortex.bat
	@printf '  ✓ Built dist/exocortexd.exe, dist/exocortex.exe, dist/exo.exe, dist/exocortex.bat\n'
	@ls -lh $(DIST_DIR)/

clean-windows:
	@rm -rf $(DIST_DIR)
	@printf '  ✓ Cleaned dist/\n'
