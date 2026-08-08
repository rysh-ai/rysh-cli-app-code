import { spawn, execFileSync, ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import * as http from 'http'
import { DaemonRegistry, isPidAlive } from './daemonRegistry'
import { findSession } from './sessionStore'

/**
 * The embedded-NATS port rysh-cli falls back to when none is configured
 * (internal/config/config.go — NATSConfig.Port). Mirrored here so the app can
 * tell whether the daemon's default is free before letting it take that path.
 */
const DEFAULT_NATS_PORT = 24242

/**
 * The outcome of looking for a live daemon's web endpoint (see
 * SidecarManager.ensureWebEndpoint):
 *
 * - endpoint:    a reachable web server — adopt it
 * - none:        no live daemon at all — cold-starting one is safe
 * - unreachable: a daemon IS alive but we cannot reach it. Never cold-start
 *   over this: a second daemon on the same session name would answer the same
 *   ws.* subjects as the first.
 */
export type EndpointLookup =
  | { kind: 'endpoint'; port: number; pid: number }
  | { kind: 'none' }
  | { kind: 'unreachable'; pid: number; reason: string }

/**
 * SidecarManager manages the Go backend process lifecycle.
 *
 * It spawns the full `rysh` binary in daemon mode with web auto-start enabled.
 * The daemon starts embedded NATS + actor hierarchy + web server, providing
 * the same backend as the TUI but accessible over HTTP/WebSocket.
 */
export class SidecarManager {
  private process: ChildProcess | null = null
  private port: number = 0
  private restartCount: number = 0
  private maxRestarts: number = 3
  private sessionName: string = 'default'
  private stopping: boolean = false
  private workingDirectory: string | null = null
  // When adopting a daemon left running by a previous app run (Detach), we have
  // no ChildProcess handle — only its PID. Tracked here so stop()/isRunning()
  // work against the adopted daemon as well as ones we spawned.
  private adoptedPid: number | null = null
  // Per-instance embedded-NATS port (RYSH_NATS_PORT). null = use the daemon's
  // built-in 24242 default, which is what the primary instance does.
  private natsPort: number | null = null
  // Per-instance JetStream store dir (RYSH_NATS_DATA_DIR). null = per-workspace
  // default. Paired with natsPort so each instance runs an independent broker.
  private natsDataDir: string | null = null
  private readonly registry: DaemonRegistry

  constructor(instanceId = 0) {
    // The registry is shared across instances; stamping our instanceId keeps the
    // records diagnosable while reaping/adoption stay keyed by (cwd, session).
    this.registry = new DaemonRegistry(instanceId)
  }

  /** The shared preserved-daemon registry (also used by main for adoption). */
  getRegistry(): DaemonRegistry {
    return this.registry
  }

  /**
   * Set the embedded-NATS port forced on this instance's daemons (via
   * RYSH_NATS_PORT). Secondary instances use a distinct port so they never share
   * a broker with the primary or each other; the primary leaves this null.
   */
  setNatsPort(port: number | null): void {
    this.natsPort = port
  }

  /**
   * Set the private JetStream store directory for this instance's daemons (via
   * RYSH_NATS_DATA_DIR). Required alongside setNatsPort so a secondary instance's
   * embedded NATS server doesn't collide with the primary's on the shared
   * ~/.rysh/nats store. The primary leaves this null (per-workspace default).
   */
  setNatsDataDir(dir: string | null): void {
    this.natsDataDir = dir
  }

  /** The working directory key used to record/look up the current daemon. */
  private cwdKey(): string {
    return this.workingDirectory || app.getPath('home')
  }

  /** PID of the current daemon (spawned or adopted), or 0 if none. */
  getPid(): number {
    return this.process?.pid ?? this.adoptedPid ?? 0
  }

  /**
   * Find a live daemon's web endpoint for {cwd, session}, starting its web
   * server if it has none.
   *
   * This is what lets the app open a session it did not create. The app's own
   * daemons are spawned with RYSH_WEB_AUTO_START, so they always have a web
   * server and the private registry knows its port. A COMMAND-LINE daemon has
   * neither: nothing listens, and the app's registry has never heard of it. The
   * renderer speaks only HTTP/WebSocket, so such a session was simply
   * unreachable — that, not the layout or the protocol, is what actually kept
   * the two front-ends apart.
   *
   * Two things fixed it. The daemon now advertises its endpoint on the session
   * record (session.UpdateWebEndpoint), so any front-end can discover a door
   * that already exists; and when there is none, `rysh web start` asks the live
   * daemon to open one over NATS — the same in-daemon `##rysh web start` a user
   * would run — with the posture the app's own daemons already use: --control,
   * which forces a loopback bind and (per autoStartWebToken) leaves it
   * untokened. No new trust boundary; the same one, reached deliberately.
   *
   * The three outcomes are distinct because they demand different responses,
   * and collapsing 'none' with 'unreachable' is actively dangerous: cold-starting
   * a second daemon for a session whose daemon is ALIVE would put two daemons on
   * one session name, both answering the same ws.* subjects.
   */
  async ensureWebEndpoint(sessionName: string, cwd: string): Promise<EndpointLookup> {
    const rec = findSession(cwd, sessionName)
    if (!rec || rec.pid <= 0 || !isPidAlive(rec.pid)) {
      return { kind: 'none' } // nothing live — the caller may safely cold-start
    }

    // A door already advertised and answering: use it as-is.
    if (rec.webPort > 0 && (await this.probeHealth(rec.webPort))) {
      return { kind: 'endpoint', port: rec.webPort, pid: rec.pid }
    }

    // Live daemon, no reachable web server — ask it to open one.
    let port: number
    try {
      port = await this.findFreePort()
    } catch {
      return { kind: 'unreachable', pid: rec.pid, reason: 'no free port for a web server' }
    }
    try {
      execFileSync(
        this.resolveBinaryPath(),
        // --control is what makes this startable at all: a user-invoked
        // `##rysh web start` demands a username/password login, while control
        // mode is loopback-only and serves just this app.
        ['web', 'start', sessionName, '--control', '--port', String(port)],
        { cwd, env: { ...process.env, HOME: app.getPath('home') }, timeout: 20000, stdio: 'pipe' }
      )
    } catch (err) {
      return {
        kind: 'unreachable',
        pid: rec.pid,
        reason: `could not request a web server: ${err instanceof Error ? err.message : err}`,
      }
    }

    // `rysh web start` is FIRE-AND-FORGET: it sends `##rysh web start` into the
    // session's active pane and returns immediately, so the exec above
    // succeeding says only that the request was delivered. The daemon writes
    // the endpoint onto the record once its listener is actually up, so poll
    // the record — and trust what it says rather than the port we asked for,
    // since a start that lost a port race reports the port that won.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const fresh = findSession(cwd, sessionName)
      if (fresh && fresh.webPort > 0 && (await this.probeHealth(fresh.webPort))) {
        return {
          kind: 'endpoint',
          port: fresh.webPort,
          pid: fresh.pid || rec.pid,
        }
      }
    }
    return {
      kind: 'unreachable',
      pid: rec.pid,
      reason: 'its web server never advertised a reachable port',
    }
  }

  /**
   * Adopt a daemon that a previous app run left running (via Detach), or one
   * this app never spawned at all (a command-line session — see
   * ensureWebEndpoint), instead of spawning a new one. Adoption preserves the
   * daemon's full in-memory state: running shells, scrollback, agent state.
   *
   * Verifies the PID is alive and the web server answers /health on the given
   * port. Returns true on success; on failure the caller should fall back to
   * start() (cold restore from KV).
   */
  async adopt(sessionName: string, cwd: string, webPort: number, pid: number): Promise<boolean> {
    if (!isPidAlive(pid)) {
      this.registry.remove(cwd, sessionName)
      return false
    }
    this.sessionName = sessionName
    this.workingDirectory = cwd
    this.port = webPort
    try {
      await this.waitForHealthy(4000)
    } catch {
      // PID alive but web server unreachable — a wedged daemon. Don't adopt.
      return false
    }
    // We don't own the process handle (it's detached from a prior run); track by
    // PID. No exit-handler / auto-restart for an adopted daemon.
    this.process = null
    this.adoptedPid = pid
    this.stopping = false
    this.restartCount = 0
    this.registry.record({
      sessionName,
      cwd,
      pid,
      webPort,
      updatedAt: new Date().toISOString(),
    })
    console.log(`[sidecar] Adopted running daemon pid=${pid} session=${sessionName} (web port: ${webPort})`)
    return true
  }

  /**
   * Detach the current daemon: leave it running and forget our handle so app
   * shutdown does NOT stop it. The registry already holds its {pid, webPort} (we
   * recorded that at start), so the next app run can adopt it. Returns the
   * preserved PID, or 0 if there was nothing running.
   */
  detach(): number {
    const pid = this.getPid()
    if (pid <= 0) return 0
    // Drop our references WITHOUT killing. unref already let the app exit
    // independently; clearing `process` ensures stop() (before-quit) is a no-op.
    if (this.process) this.process.removeAllListeners('exit')
    this.process = null
    this.adoptedPid = null
    this.stopping = true // suppress any auto-restart path
    console.log(`[sidecar] Detached daemon pid=${pid} session=${this.sessionName} (left running)`)
    return pid
  }

  /**
   * Start the Go sidecar backend.
   * Launches `rysh daemon <session>` with RYSH_WEB_AUTO_START=true and
   * RYSH_WEB_PORT=<port>. Resolves when the web server responds to /health.
   */
  async start(): Promise<void> {
    this.stopping = false
    this.adoptedPid = null
    // Reap any sidecar left over from a previous run BEFORE starting a new one.
    // A force-quit or crash skips before-quit (so stop() never ran) and leaves
    // the detached daemon alive. Two daemons for the same session on a shared
    // NATS server each spawn a WorkspaceActor, so snapshot requests get answered
    // by both with diverged state — the workspace appears to flap between two
    // sets of tabs/panes. Killing the stale daemon guarantees a single actor.
    // Deliberately-detached daemons (in the registry) are excluded from reaping.
    this.killStaleSidecars()

    this.port = await this.findFreePort()
    const binaryPath = this.resolveBinaryPath()
    const cwd = this.cwdKey()

    const { natsPort, natsDataDir } = await this.resolveNatsBroker()

    const natsPortNote = natsPort ? ` (NATS port: ${natsPort})` : ''
    console.log(
      `[sidecar] Starting: ${binaryPath} daemon ${this.sessionName} (web port: ${this.port})${natsPortNote}`
    )

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RYSH_NATS_MODE: 'embedded',
      RYSH_WEB_AUTO_START: 'true',
      RYSH_WEB_PORT: String(this.port),
      // Enable the daemon's control plane (channel start/stop, pairing
      // approve/allow, humanoid governance). Without this the renderer's
      // control endpoints all return 403, so the dashboard's Channels /
      // Pairings / Humanoids views cannot function — this is the daemon-side
      // half of openclaw_roadmap R2.
      //
      // Safe here in a way it would not be on a server: the daemon binds
      // loopback when control is on, this process spawned it, and the app is
      // the only client. It is the same trust boundary as the TUI, which can
      // already run every one of these commands.
      RYSH_WEB_CONTROL: 'true',
      // Tag every session this app launches as a desktop-app session. The
      // daemon stamps "source":"app" onto the session record, so the app only
      // ever lists/opens its own sessions and the CLI refuses to open them
      // (and vice versa).
      RYSH_SESSION_SOURCE: 'app',
      HOME: app.getPath('home'),
    }
    // Secondary instances pin their daemons to a private embedded-NATS port AND
    // a private JetStream store so each instance runs its OWN broker — instances
    // never share one NATS server, so quitting one can't tear down another's
    // clients. Both are needed: a distinct port keeps the secondary from
    // connecting to the primary's broker, and a distinct store keeps the two
    // embedded servers from fighting over ~/.rysh/nats. The primary omits both
    // and uses the daemon's 24242 default + per-workspace store (legacy) —
    // unless that default is already taken, which resolveNatsBroker() handles.
    if (natsPort) {
      env.RYSH_NATS_PORT = String(natsPort)
    }
    if (natsDataDir) {
      env.RYSH_NATS_DATA_DIR = natsDataDir
    }

    this.process = spawn(binaryPath, ['daemon', this.sessionName], {
      env,
      // Never inherit the launcher's cwd: a Finder-launched app runs at "/",
      // and the daemon anchors its session/NATS storage to a ".rysh" dir under
      // cwd (rysh-cli rysh-dir storage), so mkdir "/.rysh" fails on the
      // read-only root and the daemon exits → "disconnected". Fall back to the
      // user's home (writable; matches rysh-cli's $HOME/.rysh convention) until
      // a workspace sets an explicit working directory.
      cwd,
      // detached: the daemon becomes its own process-group leader so it can
      // OUTLIVE this app process when the user detaches (the whole point — the
      // backend keeps running with full in-memory state). unref() below lets the
      // app event loop exit without waiting on it. The daemon also redirects its
      // own stdio to /dev/null (goHeadless) shortly after start, so keeping the
      // pipes here only captures early startup diagnostics.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Don't let the (detached) daemon keep the app's event loop alive; on detach
    // we want the app to be able to quit while the daemon keeps running.
    this.process.unref()

    // Log sidecar output
    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[sidecar:stdout] ${data.toString().trim()}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[sidecar:stderr] ${data.toString().trim()}`)
    })

    this.process.on('exit', (code, signal) => {
      console.log(`[sidecar] Exited with code=${code} signal=${signal}`)
      this.process = null

      if (!this.stopping && this.restartCount < this.maxRestarts) {
        this.restartCount++
        console.log(`[sidecar] Restarting (attempt ${this.restartCount}/${this.maxRestarts})...`)
        const delay = Math.min(1000 * Math.pow(2, this.restartCount - 1), 10000)
        setTimeout(() => {
          this.start().catch((err) => {
            console.error('[sidecar] Restart failed:', err)
          })
        }, delay)
      }
    })

    this.process.on('error', (err) => {
      console.error('[sidecar] Process error:', err)
    })

    // Wait for the web server to become healthy (longer timeout since
    // the daemon needs to start NATS, restore KV state, spawn actors,
    // then auto-start the web server).
    await this.waitForHealthy(30000)
    this.restartCount = 0 // Reset on successful start

    // Record the live daemon so a later app run (after Detach) can find and
    // adopt it by PID + web port. We assign the web port, and the Go session
    // record doesn't persist it, so this app-side note is the only way back.
    const pid = this.process?.pid
    if (pid) {
      this.registry.record({
        sessionName: this.sessionName,
        cwd,
        pid,
        webPort: this.port,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  /**
   * Stop the sidecar gracefully and forget it (drops its registry record — this
   * is an intentional kill, not a detach). Handles both daemons we spawned
   * (ChildProcess handle) and ones we adopted (PID only).
   */
  async stop(): Promise<void> {
    this.stopping = true
    const cwd = this.cwdKey()
    const session = this.sessionName
    // Forget the daemon SYNCHRONOUSLY, before any await or kill: app quit calls
    // this from an async before-quit handler that Electron does NOT await, so a
    // registry write deferred past an await can be lost when the process tears
    // down — leaving a stale "running" record. Removing it first (and signalling
    // the daemon synchronously below) guarantees both happen on a hard quit.
    this.registry.remove(cwd, session)

    // Adopted daemon: no ChildProcess handle — signal by PID.
    if (!this.process && this.adoptedPid) {
      const pid = this.adoptedPid
      this.adoptedPid = null
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      await this.waitForPidExit(pid, 5000)
      return
    }

    if (!this.process) {
      return
    }

    return new Promise<void>((resolve) => {
      const proc = this.process!

      const finish = (): void => {
        clearTimeout(killTimeout)
        this.process = null
        resolve()
      }

      const killTimeout = setTimeout(() => {
        console.warn('[sidecar] Force killing after timeout')
        proc.kill('SIGKILL')
        finish()
      }, 5000)

      proc.on('exit', finish)

      // Graceful shutdown — SIGTERM triggers the daemon's shutdown handler
      proc.kill('SIGTERM')
    })
  }

  /** Resolve once `pid` is gone, SIGKILLing it if it outlives the timeout. */
  private waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
    const start = Date.now()
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (!isPidAlive(pid)) {
          resolve()
          return
        }
        if (Date.now() - start > timeoutMs) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
          resolve()
          return
        }
        setTimeout(check, 200)
      }
      check()
    })
  }

  /**
   * Get the port the sidecar web server is listening on.
   */
  getPort(): number {
    return this.port
  }

  /**
   * Get the current session name.
   */
  getSessionName(): string {
    return this.sessionName
  }

  /**
   * Set the session name (must be called before start).
   */
  setSessionName(name: string): void {
    this.sessionName = name
  }

  /**
   * Set the working directory for the sidecar process.
   * When set, the sidecar spawns with this as its CWD so the Go binary
   * finds rysh.config in the workspace directory.
   */
  setWorkingDirectory(path: string): void {
    this.workingDirectory = path
  }

  /**
   * Get the current working directory (workspace path), or null if not set.
   */
  getWorkingDirectory(): string | null {
    return this.workingDirectory
  }

  /**
   * Clear the working directory so the next start() falls back to the user's
   * home (the boot default). Used when closing a workspace to return the daemon
   * to its pre-workspace state instead of re-spawning inside the old project dir.
   */
  clearWorkingDirectory(): void {
    this.workingDirectory = null
  }

  /**
   * Check if the sidecar process (spawned or adopted) is running.
   */
  isRunning(): boolean {
    if (this.process !== null && !this.process.killed) return true
    if (this.adoptedPid && isPidAlive(this.adoptedPid)) return true
    return false
  }

  /**
   * Kill orphaned sidecar daemons started from THIS app's bundled binary.
   * Matched by the binary's full path (unique to the app), so it never touches
   * the user's own `rysh`/`ry` CLI sessions. SIGKILL (not graceful) so the
   * stale daemon stops writing the shared session KV immediately, before the
   * fresh daemon restores from it.
   *
   * Crucially, daemons we deliberately left running (Detach) are in the registry
   * and are EXCLUDED from reaping — otherwise launching a fresh app instance
   * would kill the very daemon we want to adopt. Best-effort throughout.
   */
  private killStaleSidecars(): void {
    const binaryPath = this.resolveBinaryPath()
    const preserve = new Set(this.registry.alivePids())
    const selfPid = this.getPid()
    if (selfPid > 0) preserve.add(selfPid)

    try {
      if (process.platform === 'win32') {
        // No easy PID-exclusion with taskkill /IM; if we have daemons to
        // preserve, skip reaping rather than risk killing a detached one.
        if (preserve.size > 0) return
        const image = binaryPath.split('\\').pop() || 'rysh-win-x64.exe'
        execFileSync('taskkill', ['/F', '/IM', image], { stdio: 'ignore' })
        console.log('[sidecar] Reaped stale sidecar process(es)')
        return
      }

      // Unix: enumerate matching daemon PIDs and SIGKILL only the unpreserved.
      let out = ''
      try {
        out = execFileSync('pgrep', ['-f', binaryPath], { encoding: 'utf-8' })
      } catch {
        out = '' // pgrep exits non-zero when nothing matched
      }
      const pids = out
        .split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => p > 0 && p !== process.pid && !preserve.has(p))
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      if (pids.length > 0) console.log(`[sidecar] Reaped ${pids.length} stale sidecar process(es)`)
    } catch {
      // Tool missing / nothing matched — nothing to do.
    }
  }

  /**
   * Resolve the sidecar binary path based on platform and architecture.
   * The sidecar is the full `rysh` binary.
   */
  private resolveBinaryPath(): string {
    return resolveSidecarBinaryPath()
  }

  /**
   * Find a free port for the web server to listen on.
   */
  /**
   * Decide which embedded-NATS broker this daemon should run.
   *
   * Secondaries are already pinned to a private port + store by
   * instanceManager, so they pass straight through. The PRIMARY normally takes
   * the daemon's built-in 24242 default — but that default is not ours to
   * assume. A CLI-started daemon (`rysh daemon <name>`) binds the very same
   * port, and rysh-cli's bus deliberately REUSES an existing broker instead of
   * failing (see internal/bus/bus.go, the "An existing NATS server is running
   * — reuse it" branch).
   *
   * Sharing a broker is safe in principle — KV buckets and subjects are both
   * namespaced per session — but it is ruinously expensive in practice: the
   * app's daemon becomes a TCP client of the CLI's broker, so every pane
   * snapshot crosses a loopback socket and is serialized twice instead of
   * staying in-process. Measured on a busy session: ~100 MB/s of snapshot
   * traffic, 200% CPU in the daemon, and 5.2 TB of loopback in 16 hours.
   *
   * So the primary claims 24242 only when it is genuinely free. Otherwise it
   * falls back to its own port and store, exactly like a secondary. This runs
   * after killStaleSidecars(), so a still-occupied port belongs to somebody
   * else — a CLI daemon or another session — not to a leftover of our own.
   */
  private async resolveNatsBroker(): Promise<{
    natsPort: number | null
    natsDataDir: string | null
  }> {
    if (this.natsPort) {
      return { natsPort: this.natsPort, natsDataDir: this.natsDataDir }
    }
    if (!(await this.isPortInUse(DEFAULT_NATS_PORT))) {
      return { natsPort: null, natsDataDir: this.natsDataDir }
    }
    const natsPort = await this.findFreePort()
    const natsDataDir = this.natsDataDir ?? join(app.getPath('userData'), 'nats-primary')
    console.warn(
      `[sidecar] NATS ${DEFAULT_NATS_PORT} is already in use (most likely a CLI-started ` +
        `daemon). Running a private broker on ${natsPort} instead of joining it — sharing ` +
        `a broker would push every pane snapshot over a loopback socket.`
    )
    return { natsPort, natsDataDir }
  }

  /** True if something is already listening on 127.0.0.1:<port>. */
  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new (require('net').Socket)()
      const settle = (inUse: boolean): void => {
        socket.destroy()
        resolve(inUse)
      }
      socket.setTimeout(500)
      socket.once('connect', () => settle(true))
      // A refused connection means free; a timeout means nothing usable is
      // answering, and claiming the port would fail loudly rather than
      // silently joining a foreign broker.
      socket.once('timeout', () => settle(false))
      socket.once('error', () => settle(false))
      socket.connect(port, '127.0.0.1')
    })
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = require('net').createServer()
      server.listen(0, '127.0.0.1', () => {
        const port = server.address()?.port
        server.close(() => {
          if (port) {
            resolve(port)
          } else {
            reject(new Error('Could not find free port'))
          }
        })
      })
      server.on('error', reject)
    })
  }

  /**
   * One-shot liveness probe of a web server's /health on loopback. /health is
   * deliberately exempt from the access-token gate, so this answers for a
   * tokened server too. Used to tell "a door is advertised" apart from "a door
   * is actually open" before committing to adopt a port.
   */
  private probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume() // drain, so the socket can close
        resolve(res.statusCode === 200)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        resolve(false)
      })
      req.on('error', () => resolve(false))
    })
  }

  /**
   * Wait for the web server's /health endpoint to respond with HTTP 200.
   */
  private waitForHealthy(timeoutMs: number): Promise<void> {
    const startTime = Date.now()

    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Sidecar health check timed out after ${timeoutMs}ms`))
          return
        }

        const req = http.get(`http://127.0.0.1:${this.port}/health`, (res) => {
          if (res.statusCode === 200) {
            resolve()
          } else {
            setTimeout(check, 300)
          }
        })

        req.on('error', () => {
          setTimeout(check, 300)
        })

        req.end()
      }

      // Initial delay to let the daemon process start up
      setTimeout(check, 1000)
    })
  }
}

/**
 * Path to the bundled `rysh` binary for the running platform/architecture.
 *
 * The names match the per-platform `extraResources` entries in
 * electron-builder.yml, which ship exactly one binary per artifact — so a
 * mismatch here is a missing file at runtime, not a fallback.
 */
export function resolveSidecarBinaryPath(): string {
  const platform = process.platform
  const arch = process.arch

  let binaryName = 'rysh'
  if (platform === 'darwin') {
    binaryName += `-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`
  } else if (platform === 'linux') {
    binaryName += `-linux-${arch === 'arm64' ? 'arm64' : 'x64'}`
  } else if (platform === 'win32') {
    // Not a shipping target — rysh has no PTY on native Windows. Kept so a dev
    // run on Windows resolves to something nameable rather than "rysh".
    binaryName += '-win-x64.exe'
  }

  if (is.dev) {
    // In development, look in the sidecar/ directory relative to project root
    return join(app.getAppPath(), 'sidecar', binaryName)
  }

  // In production, look in the extraResources/sidecar/ directory
  return join(process.resourcesPath, 'sidecar', binaryName)
}

let cachedSidecarVersion: string | null = null

/**
 * Version string of the bundled `rysh` binary, e.g. "v0.2.1".
 *
 * The desktop app and the CLI version independently, so a bug report that
 * names only one of them is ambiguous — the About panel shows both. Resolved
 * by running the binary once and cached: it is a ~50MB process spawn, and the
 * answer cannot change while the app is running.
 *
 * Returns "unknown" rather than throwing; a diagnostic string is never worth
 * failing a menu over.
 */
export function getSidecarVersion(): string {
  if (cachedSidecarVersion !== null) return cachedSidecarVersion

  try {
    // `rysh --version` prints e.g. "rysh v0.2.1 (commit: abc1234, built: ...)".
    // Keep the version token; the rest is noise in a dialog.
    const out = execFileSync(resolveSidecarBinaryPath(), ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    cachedSidecarVersion = out.split(/\s+/)[1] ?? out
  } catch {
    cachedSidecarVersion = 'unknown'
  }

  return cachedSidecarVersion
}
