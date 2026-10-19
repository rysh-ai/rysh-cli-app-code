import { mkdirSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'

/**
 * First-run default workspace (E-90, founder ruling R8, 2026-10-07).
 *
 * A desktop-only user used to land on a welcome screen whose only way forward
 * was opening a folder that already held a rysh.config.yaml — which nothing in
 * the app could create. Now a FIRST run (no last workspace and no recents)
 * creates ~/rysh-workspace and opens it, so the daemon starts and a pane works
 * with no CLI and no dialog. Every other boot is unchanged.
 *
 * Kept free of Electron imports so the decision is unit-testable; main.ts
 * gathers the inputs and carries out the plan.
 */

/**
 * Where the default workspace goes. The app has no user settings store (its
 * JSON files under userData hold state: window bounds, recents, the daemon
 * registry), so the location is an env var with a documented default.
 */
export const DEFAULT_WORKSPACE_ENV = 'RYSH_DEFAULT_WORKSPACE'
export const DEFAULT_WORKSPACE_DIRNAME = 'rysh-workspace'

/**
 * The config written into a new default workspace. Comment-only on purpose:
 * rysh-cli loads a missing file as built-in defaults (resolveConfig ->
 * defaultRyshDir, internal/config/config.go:2351-2397), and loadFromFile only
 * overlays fields the file sets (config.go:1516 ff.), so an empty document
 * loads to the same config as no file — the only difference being that
 * working_directory pins to this folder (config.go:2030-2039), which is the cwd
 * the app gives the daemon anyway. The file exists only because the app's own
 * gate (WorkspaceManager.validateWorkspace) asks for it.
 */
export const DEFAULT_WORKSPACE_CONFIG =
  '# rysh workspace — created by the Rysh desktop app on first run.\n' +
  "# Every setting is optional: an empty file means rysh's built-in defaults.\n" +
  '# See rysh.config.yaml.example in the rysh-cli repository for what you can set.\n'

export interface BootInputs {
  /** WorkspaceManager.getLast() returned an entry. */
  hasLast: boolean
  /** ...and that entry still passes validateWorkspace. */
  lastValid: boolean
  /** WorkspaceManager.getRecent().length */
  recentCount: number
  /** instanceManager slot 0. Secondaries have their own profile (no recents)
   *  but would land on the SAME folder and adopt the primary's daemon. */
  isPrimary: boolean
  /** rysh:// connect links that arrived with this launch (argv / open-url). */
  pendingConnectLinks: number
}

export type BootPlan =
  | { kind: 'reopen-last' }
  | { kind: 'auto-create-default' }
  | { kind: 'welcome'; reason: string }

export function planBoot(i: BootInputs): BootPlan {
  if (i.hasLast && i.lastValid) return { kind: 'reopen-last' }
  if (i.hasLast) return { kind: 'welcome', reason: 'the last workspace no longer validates' }
  if (i.recentCount > 0) return { kind: 'welcome', reason: `${i.recentCount} recent workspace(s) to choose from` }
  if (i.pendingConnectLinks > 0) return { kind: 'welcome', reason: 'a company connect link opens its own workspace' }
  if (!i.isPrimary) return { kind: 'welcome', reason: 'secondary instance — the default workspace belongs to the primary' }
  return { kind: 'auto-create-default' }
}

/**
 * $RYSH_DEFAULT_WORKSPACE if set (~ expanded; a relative path is taken from the
 * home directory, never from the launcher's cwd, which is "/" from Finder),
 * else ~/rysh-workspace.
 */
export function defaultWorkspacePath(env: Record<string, string | undefined>, home: string): string {
  const raw = (env[DEFAULT_WORKSPACE_ENV] ?? '').trim()
  if (raw === '') return join(home, DEFAULT_WORKSPACE_DIRNAME)
  if (raw === '~') return home
  const expanded = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(home, expanded)
}

export type EnsureResult =
  | { kind: 'created'; path: string }
  | { kind: 'existing'; path: string }
  | { kind: 'unusable'; path: string; reason: string }

/**
 * Make `path` a usable workspace without ever overwriting anything:
 * - missing -> create it (and parents) and write DEFAULT_WORKSPACE_CONFIG;
 * - an existing valid workspace -> use it as is;
 * - anything else (a non-workspace folder, even an empty one; a file; an error)
 *   -> unusable, with the reason, and nothing written.
 */
export function ensureDefaultWorkspace(path: string, isValidWorkspace: (dir: string) => boolean): EnsureResult {
  let exists = true
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return { kind: 'unusable', path, reason: 'the path exists and is not a folder' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'unusable', path, reason: `cannot inspect it: ${(err as Error).message}` }
    }
    exists = false
  }

  if (exists) {
    return isValidWorkspace(path)
      ? { kind: 'existing', path }
      : { kind: 'unusable', path, reason: 'the folder exists but is not a rysh workspace (no rysh.config.yaml); leaving it untouched' }
  }

  try {
    mkdirSync(path, { recursive: true })
    // 'wx': fail rather than overwrite, should something appear in between.
    writeFileSync(join(path, 'rysh.config.yaml'), DEFAULT_WORKSPACE_CONFIG, { flag: 'wx' })
  } catch (err) {
    return { kind: 'unusable', path, reason: `could not create it: ${(err as Error).message}` }
  }
  return isValidWorkspace(path)
    ? { kind: 'created', path }
    : { kind: 'unusable', path, reason: 'created, but the app does not accept it as a workspace' }
}
