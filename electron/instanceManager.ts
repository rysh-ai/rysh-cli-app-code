import { app } from 'electron'
import { spawn } from 'child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { join } from 'path'
import { isPidAlive, SHARED_DIR_NAME } from './daemonRegistry'

/**
 * Multi-instance support.
 *
 * The desktop app can run several fully-isolated instances side by side. Each
 * instance gets:
 *   - its own Electron userData profile (window state, recents, caches),
 *   - its own embedded-NATS port (so daemons never share a broker across
 *     instances — killing one instance's NATS owner can't take the others down),
 *   - its own boot session name (so per-session KV buckets never collide).
 *
 * Instance 0 is the PRIMARY: it keeps the default userData, the default NATS
 * port (24242), and the "default" boot session — i.e. byte-for-byte the legacy
 * single-instance behaviour, so existing users' state and habits are untouched.
 * EVERY plain launch allocates a real instance: the first takes slot 0, each
 * further plain launch takes the lowest free slot (1, 2, ...) — there is no
 * single-instance lock; running several apps side by side is a feature. The
 * "New Instance" menu item (or `--new-instance`) does the same from within a
 * running instance.
 *
 * Slot ownership is tracked with per-slot lockfiles under a SHARED directory
 * (independent of any instance's userData), reclaimed automatically when the
 * recorded pid is dead. This is what lets `--new-instance` pick the lowest free
 * slot atomically even when two are launched at once (O_EXCL create races to a
 * single winner; the loser moves to the next slot).
 */

/** Launch arg: allocate the lowest free SECONDARY slot (>= 1). */
const NEW_INSTANCE_FLAG = '--new-instance'
/** Launch arg: request a SPECIFIC slot, e.g. `--instance=2` (power users). */
const INSTANCE_FLAG = '--instance='
/** Base embedded-NATS port; slot N uses BASE_NATS_PORT + N. */
const BASE_NATS_PORT = 24242
/** Upper bound on concurrent instances (a sanity backstop, not a real limit). */
const MAX_SLOTS = 32

export interface InstanceInfo {
  /** Slot number. 0 = primary (legacy behaviour), >= 1 = secondary. */
  id: number
  /** True for slot 0 — keeps default userData, port, session, singleton lock. */
  isPrimary: boolean
  /**
   * Embedded-NATS port to force on this instance's daemons via RYSH_NATS_PORT,
   * or null for the primary (which uses the daemon's built-in 24242 default).
   */
  natsPort: number | null
  /**
   * Private JetStream store directory (RYSH_NATS_DATA_DIR) for this instance's
   * daemons, or null for the primary (which keeps the per-workspace default).
   * A distinct port is NOT enough on its own: the primary and a secondary both
   * boot with cwd = $HOME, so without this they'd try to start two NATS servers
   * over the same ~/.rysh/nats JetStream store and the second would fail to lock
   * it. A per-instance store keeps each instance's broker fully independent.
   */
  natsDataDir: string | null
  /** Boot session name: "default" for the primary, "default-N" otherwise. */
  bootSession: string
  /** Human label for window titles / diagnostics, e.g. "Instance 2". */
  label: string
}

/** Directory holding the cross-instance slot lockfiles. */
function slotLockDir(): string {
  // appData is the parent of userData and is NOT affected by our per-instance
  // setPath('userData', ...) override, so every instance resolves the same
  // shared location regardless of which profile it ends up using.
  return join(app.getPath('appData'), SHARED_DIR_NAME, 'instances')
}

function slotLockPath(slot: number): string {
  return join(slotLockDir(), `slot-${slot}.lock`)
}

/** The fd of the lockfile we currently hold, so we can release it on quit. */
let heldLockFd: number | null = null
let heldLockPath: string | null = null
/** This process's slot, set once allocateInstance() resolves it. */
let currentSlot = 0

// ── Presence registry (for cross-instance window switching) ──────────────────
//
// Slot lockfiles only exist for SECONDARY instances (the primary doesn't claim
// one), so they can't enumerate every running instance. Instead each instance —
// primary included — drops a `presence-<slot>.json` { slot, pid } file in the
// shared dir on startup and removes it on quit. That gives a complete, ordered
// slot->pid map so `⌘\``/`Ctrl+\`` can cycle focus across instances. Dead-pid files are
// ignored (self-healing after a crash).

interface Presence {
  slot: number
  pid: number
}

function presencePath(slot: number): string {
  return join(slotLockDir(), `presence-${slot}.json`)
}

function writePresence(slot: number): void {
  try {
    mkdirSync(slotLockDir(), { recursive: true })
    writeFileSync(
      presencePath(slot),
      JSON.stringify({ slot, pid: process.pid, startedAt: new Date().toISOString() })
    )
  } catch (err) {
    console.error('[instance] Failed to write presence file:', err)
  }
}

/** All live instances (own presence included), ordered by slot. */
function listLivePresences(): Presence[] {
  let entries: string[]
  try {
    entries = readdirSync(slotLockDir())
  } catch {
    return []
  }
  const out: Presence[] = []
  for (const e of entries) {
    if (!e.startsWith('presence-') || !e.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(slotLockDir(), e), 'utf-8'))
      if (typeof rec.slot === 'number' && typeof rec.pid === 'number' && isPidAlive(rec.pid)) {
        out.push({ slot: rec.slot, pid: rec.pid })
      }
    } catch {
      /* skip unreadable/corrupt presence file */
    }
  }
  out.sort((a, b) => a.slot - b.slot)
  return out
}

/**
 * Atomically claim `slot` by exclusively creating its lockfile. Returns true on
 * success (the fd is retained for the process lifetime). A lockfile whose
 * recorded pid is dead is treated as stale and reclaimed.
 */
function tryClaimSlot(slot: number): boolean {
  const p = slotLockPath(slot)
  mkdirSync(slotLockDir(), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' => O_CREAT | O_EXCL: fails if the file already exists.
      const fd = openSync(p, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      heldLockFd = fd
      heldLockPath = p
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Occupied — is the holder still alive?
      let pid = 0
      try {
        pid = JSON.parse(readFileSync(p, 'utf-8')).pid
      } catch {
        /* unreadable/corrupt lockfile — treat as stale */
      }
      if (pid && isPidAlive(pid)) return false // genuinely held
      // Stale (crashed holder) — remove and retry the exclusive create once.
      try {
        unlinkSync(p)
      } catch {
        /* lost the race to another reclaimer — loop will EEXIST again */
      }
    }
  }
  return false
}

/** Lowest free secondary slot (>= start), or -1 if all are taken. */
function claimLowestFreeSlot(start: number): number {
  for (let n = start; n < MAX_SLOTS; n++) {
    if (tryClaimSlot(n)) return n
  }
  return -1
}

/**
 * Build the InstanceInfo for a chosen slot, switching to a per-slot userData
 * profile for secondaries. The primary (slot 0) is left byte-for-byte as the
 * legacy single-instance app: default profile, default NATS port, "default"
 * session.
 */
function makeInstance(slot: number): InstanceInfo {
  const isPrimary = slot === 0
  if (!isPrimary) {
    // Switch to a per-slot userData profile BEFORE the app is ready. Capturing
    // the default first means we append a suffix without hard-coding the name
    // (which electron-builder sets via productName).
    const baseUserData = app.getPath('userData')
    app.setPath('userData', `${baseUserData}-${slot}`)
  }
  currentSlot = slot
  // Announce ourselves so other instances can find us for ⌘`/Ctrl+`-switching.
  writePresence(slot)
  return {
    id: slot,
    isPrimary,
    natsPort: isPrimary ? null : BASE_NATS_PORT + slot,
    natsDataDir: isPrimary
      ? null
      : join(app.getPath('appData'), SHARED_DIR_NAME, 'instances', `nats-${slot}`),
    bootSession: isPrimary ? 'default' : `default-${slot}`,
    label: isPrimary ? '' : `Instance ${slot}`,
  }
}

/**
 * Decide which instance slot this process is, claiming its lockfile and (for
 * secondaries) switching userData to a per-slot profile. MUST be called once,
 * synchronously, at the very top of the main process — before the app is ready
 * and before any userData-dependent code runs (managers, requestSingleInstanceLock).
 *
 * Policy:
 *   - A PLAIN launch is always the PRIMARY (slot 0). It takes no slot lockfile;
 *     requestSingleInstanceLock (in main) is its dedupe, so a second plain
 *     launch focuses the existing window — the unchanged legacy behaviour.
 *   - A SECONDARY instance is deliberate: `--new-instance` claims the lowest free
 *     slot >= 1, and `--instance=N` requests a specific one (falling back to the
 *     lowest free if N is taken). Secondaries are fully isolated and coexist.
 */
export function allocateInstance(): InstanceInfo {
  const argv = process.argv

  const explicitArg = argv.find((a) => a.startsWith(INSTANCE_FLAG))
  if (explicitArg) {
    const n = parseInt(explicitArg.slice(INSTANCE_FLAG.length), 10)
    if (Number.isInteger(n) && n >= 0 && n < MAX_SLOTS && tryClaimSlot(n)) {
      return makeInstance(n)
    }
    // Requested slot is taken or invalid — degrade to the lowest free slot.
    const free = claimLowestFreeSlot(0)
    return makeInstance(free >= 0 ? free : 0)
  }

  if (argv.includes(NEW_INSTANCE_FLAG)) {
    const free = claimLowestFreeSlot(1)
    // Every slot busy (pathological) — fall back to the primary path.
    return makeInstance(free >= 0 ? free : 0)
  }

  // Plain launch: EVERY launch is a real new instance. Claim the lowest free
  // slot — slot 0 (the legacy profile/port/session) included, so the first
  // launch is byte-for-byte the old primary and each further plain launch
  // stacks a fresh, fully-isolated instance beside it instead of focusing the
  // existing window. Slot 0 now holds a lockfile like every other slot (the
  // Electron single-instance lock is gone — multiple instances are the point).
  const free = claimLowestFreeSlot(0)
  return makeInstance(free >= 0 ? free : 0)
}

/** Release this process's slot lockfile. Idempotent; safe to call on quit/exit. */
export function releaseInstance(): void {
  if (heldLockFd !== null) {
    try {
      closeSync(heldLockFd)
    } catch {
      /* already closed */
    }
    heldLockFd = null
  }
  if (heldLockPath !== null) {
    try {
      unlinkSync(heldLockPath)
    } catch {
      /* already removed */
    }
    heldLockPath = null
  }
  try {
    unlinkSync(presencePath(currentSlot))
  } catch {
    /* already removed */
  }
}

/**
 * Ask the next/previous live instance (in slot order, wrapping around) to come
 * to the foreground. Cross-process focus is done by signalling the target with
 * SIGUSR2 — its main process handles that by focusing its own window
 * (app.focus({steal:true})), which needs no Accessibility/Automation permission.
 * No-op when this is the only running instance.
 */
export function focusSiblingInstance(direction: 'next' | 'prev'): void {
  const live = listLivePresences()
  if (live.length <= 1) return
  let idx = live.findIndex((p) => p.slot === currentSlot)
  if (idx < 0) idx = 0 // our own presence is missing — start from the first
  const step = direction === 'next' ? 1 : -1
  const target = live[(idx + step + live.length) % live.length]
  if (target.pid === process.pid) return
  try {
    process.kill(target.pid, 'SIGUSR2')
  } catch (err) {
    console.error('[instance] Failed to signal sibling instance:', err)
  }
}

/**
 * Spawn a brand-new SECONDARY instance: a detached child of this same
 * executable carrying `--new-instance`, which makes it allocate the next free
 * slot with its own profile/port/session. Backs the "New Instance" menu item.
 */
export function spawnNewInstance(): void {
  // Packaged: process.execPath IS the app binary. Dev: it's the electron binary,
  // which needs the app path as its first argument to launch our app.
  const prefix = app.isPackaged ? [] : [app.getAppPath()]
  try {
    const child = spawn(process.execPath, [...prefix, NEW_INSTANCE_FLAG], {
      detached: true,
      stdio: 'ignore',
      // Inherit env so a dev run still finds ELECTRON_RENDERER_URL etc.
      env: { ...process.env },
    })
    child.unref()
    console.log('[instance] Spawned a new instance')
  } catch (err) {
    console.error('[instance] Failed to spawn a new instance:', err)
  }
}
