.PHONY: help dev start stop restart status logs build build-app \
        package package-mac package-linux package-linux-appimage clean icons \
        build-sidecar build-sidecar-local build-sidecar-mac build-sidecar-linux \
        install typecheck

# Go CLI source directory (the full rysh binary serves as the sidecar)
GO_CLI_SRC ?= ../rysh-cli-code

# Sidecar output directory
SIDECAR_DIR := sidecar

# Strip the DWARF tables and symbol table from the sidecar. It is the single
# largest thing in the bundle (~66MB unstripped) and nothing in the app reads
# its symbols — Go panics still carry a usable stack trace without them.
GO_LDFLAGS := -s -w

# Host CPU architecture, for the local sidecar build.
#
# Deliberately NOT `go env GOARCH`: that reports what the INSTALLED TOOLCHAIN
# targets, which is not always what this machine is. An amd64 Go on an Apple
# Silicon Mac reports amd64, so build-sidecar-local wrote sidecar/rysh-darwin-x64
# while the app loads sidecar/rysh-darwin-arm64 — the build "succeeded" and the
# app kept running whatever stale arm64 binary was already there.
#
# Under Rosetta `uname -m` lies too (x86_64 on an arm64 Mac); sysctl.proc_translated
# is the tell. Everything else maps uname's spelling onto Go's.
HOST_ARCH := $(shell \
	if [ "$$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then echo arm64; \
	else uname -m | sed -e 's/^x86_64$$/amd64/' -e 's/^aarch64$$/arm64/'; fi)

# Absolute project root.
APP_ROOT := $(abspath .)

# start/dev/stop/restart/status go through scripts/local-run.sh (E12 order 30a,
# rr-msg-293). It starts, stops and reports ONLY what it recorded — the dev app's
# own process group (or pid) in .run/ (gitignored), and the sidecar daemons the
# app recorded in its registry plus their session records — each after an
# identity check (alive; exactly the recorded command, or this checkout's own
# sidecar path). There is no pattern kill or pattern lookup anywhere: the old
# pkill/pgrep -f matched by text and could hit other agents' processes.
LOCAL_RUN := ./scripts/local-run.sh

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
	@echo "    build-sidecar         cross-compile the daemon for every shipping target"
	@echo "    package[-mac|-linux]  build a distributable app"
	@echo "    package-linux-appimage  AppImage only (the .deb needs GNU ar)"
	@echo ""
	@echo "  Misc: install · typecheck · icons · clean"

# ── Development ──

install:
	npm install

dev: build-sidecar-local
	@DEV_LOG=$(DEV_LOG) $(LOCAL_RUN) dev

# ── Run / lifecycle (dev app) ──

# Build the local sidecar, then start the app fully DETACHED: the shell returns
# to its prompt immediately and the app keeps running independently of this
# terminal (survives closing it). Idempotent. Logs stream to $(DEV_LOG) — follow
# them with `make logs`; shut it down with `make stop`.
#
# Detachment details: `</dev/null` frees stdin (electron-vite's dev server grabs
# the terminal for its interactive shortcuts otherwise); the app runs in its OWN
# process group (job control), so a closing terminal does not signal it and
# `make stop` can stop exactly that group; its id is recorded in .run/dev.pgid.
# For an attached/foreground run that you can Ctrl+C, use `make dev` instead.
start: build-sidecar-local
	@DEV_LOG=$(DEV_LOG) $(LOCAL_RUN) start

# Stop everything this app started and RECORDED: the dev app's process group (the
# electron-vite dev server and the app's Electron processes), and the sidecar
# daemons the app recorded in its registry (incl. those its Detach feature left
# running) — each only after the identity check, so nothing that merely matches
# a text pattern is touched, and the user's own CLI rysh sessions never are.
# A daemon the app never recorded is not stopped here.
#
# THE DAEMON GETS SIGTERM, NOT SIGKILL, and the difference is not politeness —
# it is whether the session survives the restart. A pane's given name and its
# `agent.native` / `claude.session_id` metadata live in ONE KV record that is
# flushed on a client's snapshot request, plus a 1-minute safety ticker
# (internal/actors/pane_snapshot.go:318 — "lost outright on SIGKILL"). Kill -9
# and everything dirtied since the last flush is gone, which is BOTH visible
# symptoms at once: panes come back renamed to fresh animal names, and the
# post-restore resume sweep skips them, because nativeResumePlan
# (internal/actors/workspace_native_agent.go:388) resumes only panes still
# carrying the `agent.native` stamp it just lost. Observed 2026-08-14: of seven
# agent panes, the three whose record survived kept their names and resumed;
# the four that lost it lost both. SIGTERM runs the daemon's shutdown handler,
# which flushes — the app's own path does the same (electron/sidecar.ts:431).
#
# The escalation stays for a wedged daemon that ignores SIGTERM; it is the
# fallback, not the first move.
stop:
	@./scripts/guard-live-session.sh
	@$(LOCAL_RUN) stop

# Stop, then start again.
restart:
	@$(MAKE) stop
	@sleep 2
	@$(MAKE) start

# Report what's currently running (from the records only; no process-pattern lookup).
status:
	@$(LOCAL_RUN) status

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

# Build sidecar for the current platform only (for dev).
#
# GOOS/GOARCH are passed to `go build` explicitly rather than left to the
# toolchain's defaults, so a toolchain built for another architecture
# cross-compiles for THIS machine instead of producing a binary the app will
# never load. See HOST_ARCH above.
build-sidecar-local:
	@if [ "$$(uname -s)" = Darwin ]; then cd $(GO_CLI_SRC) && ./scripts/build-facetime-helper.sh; fi
	@mkdir -p $(SIDECAR_DIR)
	@echo "Building rysh sidecar for $$(go env GOOS)/$(HOST_ARCH)..."
	@GOOS=$$(go env GOOS) && GOARCH=$(HOST_ARCH) && \
	if [ "$$GOOS" = "darwin" ]; then \
		SUFFIX="darwin-$$([ $$GOARCH = arm64 ] && echo arm64 || echo x64)"; \
	elif [ "$$GOOS" = "linux" ]; then \
		SUFFIX="linux-$$([ $$GOARCH = arm64 ] && echo arm64 || echo x64)"; \
	fi && \
	cd $(GO_CLI_SRC) && GOWORK=off GOOS=$$GOOS GOARCH=$$GOARCH go build -ldflags="$(GO_LDFLAGS)" -o $(APP_ROOT)/$(SIDECAR_DIR)/rysh-$$SUFFIX ./cmd/rysh && \
	echo "Built: $(SIDECAR_DIR)/rysh-$$SUFFIX"

# Both macOS architectures. `make package-mac` needs both, because
# electron-builder.yml builds an arm64 and an x64 dmg and each pulls its own
# sidecar — an Apple Silicon dmg cannot satisfy an Intel Mac (Rosetta
# translates x64 to arm64, never the reverse).
build-sidecar-mac:
	cd $(GO_CLI_SRC) && ./scripts/build-facetime-helper.sh
	@mkdir -p $(SIDECAR_DIR)
	@echo "Cross-compiling rysh sidecar for darwin/arm64 + darwin/amd64..."
	cd $(GO_CLI_SRC) && \
	GOWORK=off GOOS=darwin GOARCH=arm64 go build -ldflags="$(GO_LDFLAGS)" -o $(APP_ROOT)/$(SIDECAR_DIR)/rysh-darwin-arm64 ./cmd/rysh && \
	GOWORK=off GOOS=darwin GOARCH=amd64 go build -ldflags="$(GO_LDFLAGS)" -o $(APP_ROOT)/$(SIDECAR_DIR)/rysh-darwin-x64   ./cmd/rysh

build-sidecar-linux:
	@mkdir -p $(SIDECAR_DIR)
	@echo "Cross-compiling rysh sidecar for linux/amd64..."
	cd $(GO_CLI_SRC) && \
	GOWORK=off GOOS=linux GOARCH=amd64 go build -ldflags="$(GO_LDFLAGS)" -o $(APP_ROOT)/$(SIDECAR_DIR)/rysh-linux-x64 ./cmd/rysh

# Every sidecar a shipping target needs. Windows is not built: rysh has no PTY
# on native Windows, so that target is not shipped (see docs/RELEASE-PLAN.md).
build-sidecar: build-sidecar-mac build-sidecar-linux
	@echo "All sidecar binaries built."

# ── Icons ──

# Rasterise resources/*.svg into the icns/ico/png the packager consumes. The
# outputs are checked in, so this only needs re-running when an SVG changes.
icons:
	./scripts/gen-icons.sh

# ── Packaging ──

package: build-sidecar build
	npm run package

package-mac: build-sidecar-mac build
	npm run make:mac

# The preflight refuses the .deb target when `ar` is not GNU, because that
# combination does not fail — it writes a 96-byte package, names it correctly and
# exits 0 (E-53). It runs here rather than inside electron-builder because CI
# invokes `npx electron-builder` directly (.github/workflows/electron-build.yml)
# and never reads this Makefile, so nothing added here can break the release
# path. Since W4 the `make:linux` npm script runs the preflight too, so this
# line is now redundant on this path and kept deliberately: neither entry point
# should depend on the other keeping the guard. The preflight is idempotent.
package-linux: build-sidecar-linux build
	./scripts/preflight-linux-deb.sh
	npm run make:linux

# AppImage only — the half of Linux packaging that a macOS host builds
# correctly (E-53 measured the AppImage from a macOS build as a genuine 101 MB
# x86-64 ELF; only the .deb is corrupt). It deliberately does not consult the
# preflight, so refusing the .deb never disables Linux packaging wholesale.
package-linux-appimage: build-sidecar-linux build
	npx electron-builder --linux AppImage --x64 --publish never

# ── Cleanup ──

clean:
	rm -rf dist release node_modules $(SIDECAR_DIR)/rysh-*
	@echo "Cleaned."
