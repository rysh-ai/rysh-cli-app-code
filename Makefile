.PHONY: help dev start stop restart status logs build build-app \
        package package-mac package-win package-linux clean \
        build-sidecar build-sidecar-local install typecheck

# Go CLI source directory (the full rysh binary serves as the sidecar)
GO_CLI_SRC := ../rysh-cli-code

# Sidecar output directory
SIDECAR_DIR := sidecar

# Absolute project root. start/stop/status match processes by this path so they
# only ever touch THIS app — its dev server, Electron, and the daemons it
# spawned — never the user's own `rysh`/`ry` CLI sessions.
APP_ROOT := $(abspath .)

# Process-match patterns. The first letter is bracketed (e.g. [r]ysh) so the
# pgrep/pkill command never matches ITS OWN command line — a classic footgun.
DEV_MATCH         := [e]lectron-vite dev
ELECTRON_UI_MATCH := $(APP_ROOT)/node_modules/electron/dist/Electron.app/Contents/MacOS/[E]lectron
ELECTRON_ALL_MATCH:= $(APP_ROOT)/node_modules/[e]lectron/dist/Electron.app
SIDECAR_MATCH     := $(APP_ROOT)/$(SIDECAR_DIR)/[r]ysh-

# Background dev-app log (see `make start` / `make logs`).
DEV_LOG := /tmp/rysh-app-dev.log

.DEFAULT_GOAL := help

# ── Help ──

help:
	@echo "rysh desktop app — make targets"
	@echo ""
	@echo "  Run:"
	@echo "    start       build local sidecar + start the app DETACHED (returns to prompt; logs: $(DEV_LOG))"
	@echo "    stop        stop the dev server, the app UI, and the daemons it spawned"
	@echo "    restart     stop + start"
	@echo "    status      show what's running"
	@echo "    logs        follow the background app log"
	@echo "    dev         run attached in the foreground (Ctrl+C to quit)"
	@echo ""
	@echo "  Build:"
	@echo "    build-app             full local build: sidecar (this platform) + JS bundles"
	@echo "    build                 JS bundles only (electron-vite build)"
	@echo "    build-sidecar-local   build the Go daemon for this platform"
	@echo "    build-sidecar         cross-compile the daemon for all platforms"
	@echo "    package[-mac|-win|-linux]   build a distributable app"
	@echo ""
	@echo "  Misc: install · typecheck · clean"

# ── Development ──

install:
	npm install

dev: build-sidecar-local
	npm run dev

# ── Run / lifecycle (dev app) ──

# Build the local sidecar, then start the app fully DETACHED: the shell returns
# to its prompt immediately and the app keeps running independently of this
# terminal (survives closing it). Idempotent. Logs stream to $(DEV_LOG) — follow
# them with `make logs`; shut it down with `make stop`.
#
# Detachment details: `</dev/null` frees stdin (electron-vite's dev server grabs
# the terminal for its interactive shortcuts otherwise — the usual cause of a
# "backgrounded but still attached/hanging" launch); `nohup` ignores SIGHUP so a
# closing terminal can't kill it; and `( … & )` orphans it to launchd right away
# so `make` never tracks or waits on it. For an attached/foreground run that you
# can Ctrl+C, use `make dev` instead.
start: build-sidecar-local
	@if pgrep -f "$(ELECTRON_UI_MATCH)" >/dev/null 2>&1; then \
		echo "rysh app is already running — use 'make restart' to relaunch."; \
	else \
		echo "Starting rysh app, detached (logs: $(DEV_LOG))..."; \
		( nohup npm run dev </dev/null > $(DEV_LOG) 2>&1 & ); \
		echo "Started independently of this shell. Follow logs: make logs   ·   Stop: make stop"; \
	fi

# Stop everything this app started: the electron-vite dev server, the app's
# Electron processes (main + helpers), and the sidecar daemons it spawned —
# matched by this app's path, so the user's own CLI rysh sessions are untouched.
# Note: this also stops daemons the app's Detach feature left running (it is a
# full dev teardown).
stop:
	@echo "Stopping rysh app..."
	@pkill -f "$(DEV_MATCH)" 2>/dev/null || true
	@pkill -f "$(ELECTRON_ALL_MATCH)" 2>/dev/null || true
	@pkill -9 -f "$(SIDECAR_MATCH)" 2>/dev/null || true
	@echo "Stopped."

# Stop, then start again.
restart:
	@$(MAKE) stop
	@sleep 2
	@$(MAKE) start

# Report what's currently running.
status:
	@pgrep -f "$(DEV_MATCH)"         >/dev/null 2>&1 && echo "dev server : running" || echo "dev server : stopped"
	@pgrep -f "$(ELECTRON_UI_MATCH)" >/dev/null 2>&1 && echo "app UI     : running" || echo "app UI     : stopped"
	@printf "daemons    : %s running\n" "$$(pgrep -f "$(SIDECAR_MATCH)" 2>/dev/null | wc -l | tr -d ' ')"

# Follow the background app log.
logs:
	@tail -n 100 -f $(DEV_LOG)

# ── Type Checking ──

typecheck:
	npm run typecheck

# ── Build ──

build:
	npm run build

# Full local build of the app: the Go daemon for the current platform plus the
# Electron main/preload/renderer bundles. This is "build the rysh app".
build-app: build-sidecar-local build
	@echo "Built rysh app (sidecar + JS bundles)."

# ── Sidecar (Go backend — full rysh binary) ──

# Build sidecar for the current platform only (for dev)
build-sidecar-local:
	@mkdir -p $(SIDECAR_DIR)
	@echo "Building rysh sidecar for $$(go env GOOS)/$$(go env GOARCH)..."
	@GOOS=$$(go env GOOS) GOARCH=$$(go env GOARCH) && \
	if [ "$$GOOS" = "darwin" ]; then \
		SUFFIX="darwin-$$([ $$GOARCH = arm64 ] && echo arm64 || echo x64)"; \
	elif [ "$$GOOS" = "linux" ]; then \
		SUFFIX="linux-$$([ $$GOARCH = arm64 ] && echo arm64 || echo x64)"; \
	elif [ "$$GOOS" = "windows" ]; then \
		SUFFIX="win-x64.exe"; \
	fi && \
	cd $(GO_CLI_SRC) && GOWORK=off go build -o ../rysh-cli-app-code/$(SIDECAR_DIR)/rysh-$$SUFFIX . && \
	echo "Built: $(SIDECAR_DIR)/rysh-$$SUFFIX"

# Build sidecar for all platforms (for distribution)
build-sidecar:
	@mkdir -p $(SIDECAR_DIR)
	@echo "Cross-compiling rysh sidecar for all platforms..."
	cd $(GO_CLI_SRC) && \
	GOWORK=off GOOS=darwin  GOARCH=arm64 go build -o ../rysh-cli-app-code/$(SIDECAR_DIR)/rysh-darwin-arm64 . && \
	GOWORK=off GOOS=darwin  GOARCH=amd64 go build -o ../rysh-cli-app-code/$(SIDECAR_DIR)/rysh-darwin-x64   . && \
	GOWORK=off GOOS=linux   GOARCH=amd64 go build -o ../rysh-cli-app-code/$(SIDECAR_DIR)/rysh-linux-x64    . && \
	GOWORK=off GOOS=linux   GOARCH=arm64 go build -o ../rysh-cli-app-code/$(SIDECAR_DIR)/rysh-linux-arm64  . && \
	GOWORK=off GOOS=windows GOARCH=amd64 go build -o ../rysh-cli-app-code/$(SIDECAR_DIR)/rysh-win-x64.exe  .
	@echo "All sidecar binaries built."

# ── Packaging ──

package: build-sidecar build
	npm run package

package-mac: build-sidecar-local build
	npm run make:mac

package-win: build-sidecar build
	npm run make:win

package-linux: build-sidecar build
	npm run make:linux

# ── Cleanup ──

clean:
	rm -rf dist release node_modules $(SIDECAR_DIR)/rysh-*
	@echo "Cleaned."
