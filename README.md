# rysh-cli-app-code

Rysh Desktop — the Electron app for [Rysh](https://github.com/rysh-ai/rysh-cli-parent),
and the web renderer the CLI serves from `rysh web start`.

One codebase, two targets:

| Target | Built with | Where it runs |
| --- | --- | --- |
| **desktop** | `electron-vite` | a native window on macOS, Windows, Linux, with the `rysh` binary bundled as a sidecar |
| **web** | `vite.web.config.ts` | embedded into the CLI at `internal/web/static`, served by `rysh web start` |

The desktop app ships the CLI inside it, so a user installs one thing and gets
both. The web target is the same renderer with no Electron around it, which is
what you reach from a browser or a phone.

## Requirements

- **Node.js 22.12 or newer**, and npm. Electron 41 requires it — on an older
  Node, `npm install` fails in Electron's postinstall with `ERR_REQUIRE_ESM`.
- Go 1.25.3 or newer — only to build the sidecar binary
- A checkout of [`rysh-cli-code`](https://github.com/rysh-ai/rysh-cli-code) as a
  sibling directory, for the same reason

Cloning [`rysh-cli-parent`](https://github.com/rysh-ai/rysh-cli-parent) with
`--recursive` gives you that layout:

```
rysh-cli-parent/
├── rysh-cli-code/       the CLI — also the sidecar binary
├── rysh-cli-shared/
└── rysh-cli-app-code/   you are here
```

## Run it

```sh
npm install
make dev            # builds the sidecar for your platform, then opens the app
```

Only after the web renderer, not the desktop app? That part needs no Electron
binary, so `npm ci --ignore-scripts` is enough and any Node 18+ will do.

`make dev` runs `electron-vite dev`: hot reload on the renderer, and the app
talks to a real `rysh` daemon it spawned itself. To run it detached from your
terminal instead, `make start` puts it in the background and `make logs` tails
it. `make stop` and `make status` do what they say — they match on this
directory's absolute path, so they never touch a `rysh` session you started
yourself.

## Build

```sh
make build           # renderer + electron main -> dist/
make build-app       # sidecar + build, the full desktop bundle
make typecheck       # tsc over both tsconfigs, no emit
```

Packaging an installer, per platform:

```sh
make package-mac     # .dmg and .zip, arm64 + x64
make package-win     # NSIS installer
make package-linux
```

`electron-builder.yml` holds the packaging config — app id `com.rysh.desktop`,
code-signing entitlements, target matrix. Output lands in `release/`.

### The web target

```sh
npx vite build --config vite.web.config.ts
```

This writes straight into `../rysh-cli-code/internal/web/static`, which the CLI
picks up through `//go:embed`. Rebuild the Go binary afterwards or the old
assets stay baked in. From the CLI side, `make build-frontend` does the same
thing.

## Layout

| Path | What |
| --- | --- |
| `src/` | the React renderer — panes, input handling, file browser, email client |
| `electron/` | main process: window and menu management, IPC, shell completion |
| `scripts/build-sidecar.sh` | cross-compiles the `rysh` binary into `sidecar/` |
| `electron.vite.config.ts` | desktop build |
| `vite.web.config.ts` | web build, output redirected into the CLI |
| `resources/` | icons and macOS entitlements |

The renderer detects which UI to show — desktop, or the phone-sized drill-down —
from the URL and the pointer type, so the same bundle serves a laptop browser
and a phone without a separate build.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
