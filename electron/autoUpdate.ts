import { BrowserWindow, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createUpdateLog, type UpdateLog } from './updateLog'

/**
 * AutoUpdateManager handles checking for updates, downloading them,
 * and prompting the user to restart.
 *
 * Uses electron-updater with GitHub Releases as the update source. Every event
 * also goes to <logDir>/updater.log (updateLog.ts), which is electron-updater's
 * own logger too, so an app started from Finder leaves a record (R8b).
 */
export class AutoUpdateManager {
  private window: BrowserWindow
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private log: UpdateLog

  constructor(window: BrowserWindow, logDir: string) {
    this.window = window
    this.log = createUpdateLog(logDir)
    autoUpdater.logger = this.log

    // Configure auto-updater
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    // Set up event handlers
    autoUpdater.on('checking-for-update', () => {
      console.log('[autoUpdate] Checking for updates...')
      this.log.info('[autoUpdate] Checking for updates...')
    })

    autoUpdater.on('update-available', (info) => {
      console.log(`[autoUpdate] Update available: v${info.version}`)
      this.log.info(`[autoUpdate] Update available: v${info.version}`)
    })

    autoUpdater.on('update-not-available', () => {
      console.log('[autoUpdate] No updates available')
      this.log.info('[autoUpdate] No updates available')
    })

    autoUpdater.on('download-progress', (progress) => {
      console.log(`[autoUpdate] Download progress: ${progress.percent.toFixed(1)}%`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[autoUpdate] Update downloaded: v${info.version}`)
      this.log.info(`[autoUpdate] Update downloaded: v${info.version}`)
      this.promptRestart(info.version)
    })

    autoUpdater.on('error', (err) => {
      console.error('[autoUpdate] Error:', err)
      this.log.error('[autoUpdate] Error:', err)
    })
  }

  /**
   * Check for updates immediately and set up periodic checks.
   */
  checkForUpdates(): void {
    // Check now
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[autoUpdate] Check failed:', err)
      this.log.error('[autoUpdate] Check failed:', err)
    })

    // Check every 4 hours
    this.checkInterval = setInterval(
      () => {
        autoUpdater.checkForUpdates().catch((err) => {
          console.error('[autoUpdate] Periodic check failed:', err)
          this.log.error('[autoUpdate] Periodic check failed:', err)
        })
      },
      4 * 60 * 60 * 1000
    )
  }

  /**
   * Stop periodic update checks.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  /**
   * Show a dialog prompting the user to restart to apply the update.
   */
  private async promptRestart(version: string): Promise<void> {
    const result = await dialog.showMessageBox(this.window, {
      type: 'info',
      title: 'Update Available',
      message: `Rysh v${version} has been downloaded.`,
      detail: 'Restart now to apply the update?',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })

    if (result.response === 0) {
      autoUpdater.quitAndInstall()
    }
  }
}
