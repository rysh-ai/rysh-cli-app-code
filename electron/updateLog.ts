import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'fs'
import { join } from 'path'

/**
 * The updater's file log (R8b, sprint 0.2.15): an app started from Finder has
 * no visible stdout, so the updater also writes <app logs>/updater.log
 * (app.getPath('logs'), named after package.json's `name`: macOS
 * ~/Library/Logs/rysh-cli-app, Linux ~/.config/rysh-cli-app/logs). The file is this
 * user's own, 0600, in a directory created 0700; it is never opened through a
 * symlink; past maxBytes it rotates to updater.log.1 (one old file kept); and
 * no write problem ever reaches the app. It is also electron-updater's logger.
 */
export const UPDATE_LOG_NAME = 'updater.log'

export interface UpdateLog {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

function oneLine(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.name}: ${a.message}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
    .replace(/[\r\n]+/g, ' ')
}

export function createUpdateLog(dir: string, opts: { maxBytes?: number } = {}): UpdateLog {
  const maxBytes = opts.maxBytes ?? 1 << 20
  const path = join(dir, UPDATE_LOG_NAME)
  const write = (level: string, args: unknown[]): void => {
    try {
      const line = `${new Date().toISOString()} ${level.padEnd(5)} ${oneLine(args)}\n`
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      let size = 0
      try {
        const st = lstatSync(path)
        if (!st.isFile()) return // a symlink or anything else at the log path: drop the line
        size = st.size
      } catch {
        /* no file yet */
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(path, path + '.1')
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        if ((fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, 0o600)
        writeSync(fd, line)
      } finally {
        closeSync(fd)
      }
    } catch {
      /* the log never reaches the app */
    }
  }
  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    debug: (...a) => write('debug', a),
  }
}
