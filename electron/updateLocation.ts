import { accessSync, constants } from 'fs'
import { dirname } from 'path'

/**
 * L8 (sprint 0.2.16): can this copy of the app replace itself with an update?
 * Squirrel.Mac swaps the whole .app bundle in place, so it needs the bundle to
 * sit at a real path in a folder this user may write.
 * - cannot-update: macOS runs the app translocated (a read-only random path
 *   under …/AppTranslocation/, e.g. never moved out of Downloads) or straight
 *   from the mounted disk image (/Volumes/…). The swap cannot happen there;
 *   "Restart Now" used to hang without a word (R8b-2, 11-05).
 * - needs-admin: the folder holding Rysh.app is not writable by this user (a
 *   Standard user and root-owned /Applications): macOS asks for an
 *   administrator's name and password at install (R8b finding 1, 11-04).
 * - ok: anything else, and every non-macOS or non-bundle run.
 */
export type UpdateLocation =
  | { kind: 'ok' }
  | { kind: 'cannot-update'; advice: string }
  | { kind: 'needs-admin'; folder: string }

/** The .app bundle that holds the executable, or null outside one. */
export function appBundleOf(execPath: string): string | null {
  const m = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/)
  return m ? m[1] : null
}

const MOVE_ADVICE =
  'Quit Rysh, drag it into your Applications folder (or the Applications folder in your home folder), ' +
  'and open it from there. Updates then install normally.'

export function updateLocation(execPath: string, platform: NodeJS.Platform): UpdateLocation {
  if (platform !== 'darwin') return { kind: 'ok' }
  const bundle = appBundleOf(execPath)
  if (!bundle) return { kind: 'ok' }
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
    return { kind: 'cannot-update', advice: MOVE_ADVICE }
  }
  const folder = dirname(bundle)
  try {
    accessSync(folder, constants.W_OK)
    return { kind: 'ok' }
  } catch {
    return { kind: 'needs-admin', folder }
  }
}
