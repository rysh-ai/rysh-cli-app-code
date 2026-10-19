import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { execFile, type ChildProcess } from 'node:child_process'
import { contactsRequest, callRequest, decodeReply, type FaceTimeRequest } from './facetimeService'
import type { FaceTimeReply } from '../src/types/facetime'

// Only the main app frame at the known renderer URL may access local contacts.
// Web panes, child frames and navigated main windows are rejected.
export function registerFaceTimeHandlers(win: BrowserWindow, rendererURL: string, binary: () => string): void {
  const expectedURL = new URL(rendererURL).href
  let active: ChildProcess | undefined
  const allowed = (event: IpcMainInvokeEvent) => {
    if (win.isDestroyed() || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== expectedURL) {
      throw new Error('FaceTime is only available in the Rysh desktop window.')
    }
  }
  const cancel = () => { active?.kill('SIGTERM') }
  win.on('closed', () => {
    cancel()
    for (const name of ['facetime-doctor', 'facetime-contacts', 'facetime-call', 'facetime-cancel']) {
      ipcMain.removeHandler(name)
    }
  })
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) cancel()
  })
  const run = (request: FaceTimeRequest): Promise<FaceTimeReply> => {
    if (process.platform !== 'darwin') return Promise.resolve({ version: 1, code: 'unsupported_platform', error: 'FaceTime requires macOS.' })
    if (active) return Promise.resolve({ version: 1, error: 'Finish or cancel the current Contacts request first.' })
    return new Promise((resolve) => {
      // Direct executable + stdin JSON: no shell, recipient arguments, daemon or logs.
      const child = execFile(binary(), ['facetime', 'bridge'], {
        timeout: 130_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout) => {
        if (active === child) active = undefined
        if (error) {
          resolve({ version: 1, error: 'Contacts request canceled or helper unavailable. Check your Rysh installation and Contacts permission.' })
          return
        }
        try { resolve(decodeReply(stdout)) }
        catch { resolve({ version: 1, error: 'Invalid Contacts response. Update the app and its sidecar together.' }) }
      })
      active = child
      child.stdin?.on('error', () => { /* Process exit is reported by execFile. */ })
      child.stdin?.end(JSON.stringify(request))
    })
  }
  ipcMain.handle('facetime-doctor', (event) => { allowed(event); return run({ version: 1, operation: 'doctor' }) })
  ipcMain.handle('facetime-contacts', (event, search: unknown, offset?: unknown) => {
    allowed(event); return run(contactsRequest(search, offset))
  })
  ipcMain.handle('facetime-call', (event, contactID: unknown, addressID: unknown, expectedValue: unknown) => {
    allowed(event); return run(callRequest(contactID, addressID, expectedValue))
  })
  ipcMain.handle('facetime-cancel', (event) => { allowed(event); cancel() })
}
