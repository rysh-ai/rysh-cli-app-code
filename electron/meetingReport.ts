import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, normalize } from 'node:path'

// The meeting pane header's "Report" link (E-81, design 045). The reporter
// writes <rysh dir>/meetings/<id>/report.md (interim and final share the
// file) and the daemon records its path in the pane's `meeting.report` meta.
// The renderer passes that path back here to open it; this is the only file
// it can open this way, so the path is checked for that exact shape and on
// disk before the OS opens it. The rysh dir itself is the daemon's to resolve
// (config file, RYSH_DIR, walk-up), so it is not re-derived here.

const MEETING_ID = /^m-[0-9a-f]{6}$/

/** `path` when it is `<absolute>/meetings/<meetingId>/report.md`, normalized; else null. */
export function meetingReportPath(meetingId: string, path: string): string | null {
  if (typeof meetingId !== 'string' || typeof path !== 'string' || !MEETING_ID.test(meetingId)) return null
  if (!isAbsolute(path) || normalize(path) !== path) return null
  if (basename(path) !== 'report.md') return null
  const dir = dirname(path)
  if (basename(dir) !== meetingId || basename(dirname(dir)) !== 'meetings') return null
  return path
}

export interface OpenReportResult {
  success: boolean
  error?: string
}

/** Registers `meeting-open-report`: only the app window's own frame may call it. */
export function registerMeetingReportHandler(win: BrowserWindow, rendererURL: string): void {
  const expectedURL = new URL(rendererURL).href
  const allowed = (event: IpcMainInvokeEvent) => {
    if (win.isDestroyed() || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== expectedURL) {
      throw new Error('Meeting reports open only from the Rysh desktop window.')
    }
  }
  win.on('closed', () => ipcMain.removeHandler('meeting-open-report'))
  ipcMain.handle('meeting-open-report', async (event, meetingId: unknown, path: unknown): Promise<OpenReportResult> => {
    allowed(event)
    const p = meetingReportPath(meetingId as string, path as string)
    if (!p) return { success: false, error: 'not this meeting\'s report' }
    try {
      // A regular file, reached without a symlink anywhere on the way.
      const st = await lstat(p)
      if (!st.isFile() || (await realpath(p)) !== p) return { success: false, error: 'not a report file' }
    } catch {
      return { success: false, error: 'the report is not there (yet)' }
    }
    const err = await shell.openPath(p)
    return err ? { success: false, error: err } : { success: true }
  })
}
