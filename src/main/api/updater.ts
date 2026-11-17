import { app, BrowserWindow, dialog, ipcMain, screen, shell, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getPreloadPath, getRendererPath } from '../utils/appBundlePath'
import createPlatformUpdater from '@platform-updater'
import type { PlatformUpdateInfo, PlatformUpdaterService } from './platformUpdater/types'
import databaseAPI from './shared/database.js'
import windowManager from '../managers/windowManager'
import { applyWindowMaterial, getDefaultWindowMaterial } from '../utils/windowUtils.js'
import {
  compareSemverVersions,
  FORK_GITHUB_LATEST_RELEASE_URL,
  FORK_OWNER,
  FORK_REPO,
  getForkReleaseFeedUrl,
  GITHUB_LATEST_RELEASE_URL,
  isInAppUpdateSource,
  type ForkUpdateAnalysis,
  type UpdateOrigin,
  type UpdatePreferences
} from '../../shared/updateSource'
import { HOST_STORAGE_KEYS } from '../../shared/storageKeys'
import { resolveUpdateChannel } from '../../shared/updateChannel'
import { checkForkAndOfficialUpdates, type CombinedUpdateCheckResult } from './forkUpdateAnalyzer'

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000

export class UpdaterAPI {
  private mainWindow: BrowserWindow | null = null
  private availableUpdateInfo: PlatformUpdateInfo | null = null
  private downloadedUpdateInfo: PlatformUpdateInfo | null = null
  private updateWindow: BrowserWindow | null = null
  private platformUpdater: PlatformUpdaterService | null = null
  private initializationPromise: Promise<void> = Promise.resolve()
  private lastAutoNotifiedVersion = ''
  private autoCheckTimer: NodeJS.Timeout | null = null
  private autoCheckEnabled = false
  private autoCheckInFlight = false
  private latestAnalysis: ForkUpdateAnalysis | null = null

  /**
   * 初始化平台更新服务并注册更新窗口使用的 IPC。
   * @param mainWindow 接收更新状态事件的主窗口。
   * @returns 无返回值。
   */
  public init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.platformUpdater = createPlatformUpdater({
      onDownloadStart: (info) => this.sendUpdateEvent('update-download-start', info),
      onDownloadProgress: (info) => this.sendUpdateEvent('update-download-progress', info),
      onDownloadCancelled: () => this.sendUpdateEvent('update-download-cancelled', undefined),
      onDownloaded: (info, showWindow) => this.handleUpdateDownloaded(info, showWindow),
      onDownloadFailed: (error) => this.sendUpdateEvent('update-download-failed', { error }),
      onBeforeInstall: () => windowManager.setQuitting(true)
    })
    this.initializationPromise = this.platformUpdater.initialize().catch((error) => {
      console.error('[Updater] 初始化平台更新器失败:', error)
    })

    this.setupIPC()
    this.setAutoCheck(databaseAPI.dbGet('settings-general')?.autoCheckUpdate !== false)
  }

  private handleUpdateDownloaded(info: PlatformUpdateInfo, showWindow: boolean): void {
    this.availableUpdateInfo = info
    this.downloadedUpdateInfo = info
    this.sendUpdateEvent('update-downloaded', info)
    if (showWindow) this.createUpdateWindow()
  }

  private sendUpdateEvent(channel: string, payload: unknown): void {
    this.mainWindow?.webContents.send(channel, payload)
    if (this.updateWindow && !this.updateWindow.isDestroyed()) {
      this.updateWindow.webContents.send(channel, payload)
    }
  }

  private showAvailableUpdate(info: PlatformUpdateInfo): void {
    this.notifyAvailableUpdate(info)
    this.createUpdateWindow()
  }

  private notifyAvailableUpdate(info: PlatformUpdateInfo): void {
    this.availableUpdateInfo = info
    this.sendUpdateEvent('update-available', info)
  }

  /**
   * 注册更新检查、下载、取消和安装相关的 IPC 处理器。
   * @returns 无返回值。
   */
  private setupIPC(): void {
    ipcMain.handle('updater:check-update', () => this.checkUpdate())
    ipcMain.handle('updater:show-update-window', () => this.showUpdateWindow())
    ipcMain.handle('updater:start-update', (_event, sourceID?: number) =>
      this.startUpdate(sourceID)
    )
    ipcMain.handle('updater:cancel-update', () => this.cancelUpdate())
    ipcMain.handle('updater:reset-download-state', () => this.resetDownloadState())
    ipcMain.handle('updater:open-download-source', (_event, sourceID: number) =>
      this.openDownloadSource(sourceID)
    )
    ipcMain.handle('updater:install-downloaded-update', () => this.installDownloadedUpdate())
    ipcMain.handle('updater:get-download-status', () => this.getDownloadStatus())
    ipcMain.handle('updater:get-preferences', () => this.getUpdatePreferences())
    ipcMain.handle('updater:set-preferences', (_event, prefs: Partial<UpdatePreferences>) =>
      this.setUpdatePreferences(prefs)
    )
    ipcMain.handle('updater:analyze-fork-update', (_event, forceRefresh?: boolean) =>
      this.analyzeForkUpdate(forceRefresh)
    )

    ipcMain.on('updater:quit-and-install', () => void this.installDownloadedUpdate())
    ipcMain.on('updater:minimize-window', () => this.minimizeUpdateWindow())
    ipcMain.on('updater:close-window', () => this.closeUpdateWindow())
    ipcMain.on('updater:window-ready', () => {
      const info = this.availableUpdateInfo ?? this.downloadedUpdateInfo
      if (this.updateWindow && info) {
        this.updateWindow.webContents.send('update-info', {
          ...info,
          currentVersion: info.currentVersion ?? app.getVersion(),
          forkAnalysis: info.forkAnalysis ?? this.latestAnalysis ?? undefined,
          preferences: this.getUpdatePreferences(),
          downloadStatus: this.getDownloadStatus()
        })
      }
    })
  }

  /**
   * 判断当前设备配置是否订阅 Beta 更新通道。
   * @returns 当前是否应包含预发布版本。
   */
  private shouldIncludePrerelease(): boolean {
    try {
      const settings = databaseAPI.dbGet(HOST_STORAGE_KEYS.settingsGeneral)
      return (
        resolveUpdateChannel(app.getVersion(), settings?.receiveBetaUpdates === true) === 'beta'
      )
    } catch {
      return resolveUpdateChannel(app.getVersion()) === 'beta'
    }
  }

  /**
   * 读取当前设备的更新偏好设置，未配置时默认优先使用“我的源”。
   * @returns 更新源偏好及是否关闭官方新版本提示的状态。
   */
  public getUpdatePreferences(): UpdatePreferences {
    const settings = databaseAPI.dbGet(HOST_STORAGE_KEYS.settingsGeneral)
    return {
      preferredUpdateSource: settings?.preferredUpdateSource === 'official' ? 'official' : 'mine',
      ignoreOfficialUpdateNotice: settings?.ignoreOfficialUpdateNotice === true
    }
  }

  /**
   * 更新并持久化应用更新偏好设置，同步通知主窗口与更新窗口刷新展示状态。
   * @param patch 需要修改的更新偏好字段。
   * @returns 合并持久化后的最新更新偏好配置。
   */
  public setUpdatePreferences(patch: Partial<UpdatePreferences>): UpdatePreferences {
    const existing = databaseAPI.dbGet(HOST_STORAGE_KEYS.settingsGeneral) || {}
    const current = this.getUpdatePreferences()
    const nextPrefs: UpdatePreferences = {
      preferredUpdateSource:
        patch.preferredUpdateSource === 'official' || patch.preferredUpdateSource === 'mine'
          ? patch.preferredUpdateSource
          : current.preferredUpdateSource,
      ignoreOfficialUpdateNotice:
        typeof patch.ignoreOfficialUpdateNotice === 'boolean'
          ? patch.ignoreOfficialUpdateNotice
          : current.ignoreOfficialUpdateNotice
    }

    // 持久化到通用设置，保证重启后仍记住用户偏好。
    databaseAPI.dbPut?.(HOST_STORAGE_KEYS.settingsGeneral, {
      ...existing,
      preferredUpdateSource: nextPrefs.preferredUpdateSource,
      ignoreOfficialUpdateNotice: nextPrefs.ignoreOfficialUpdateNotice
    })

    // 若关闭官方新版本提示，清理仅针对官方源的可用更新缓存，避免主窗口再次弹出。
    if (nextPrefs.ignoreOfficialUpdateNotice && this.availableUpdateInfo?.origin === 'official') {
      this.availableUpdateInfo = null
    }

    this.sendUpdateEvent('update-preferences-changed', nextPrefs)
    return nextPrefs
  }

  /**
   * 清理当前已下载或失败的更新器缓存，确保用户在更新弹窗切换源后能直接发起新下载。
   * @returns 重置结果及重置后的下载状态摘要。
   */
  public resetDownloadState(): {
    success: boolean
    status: ReturnType<UpdaterAPI['getDownloadStatus']>
  } {
    this.downloadedUpdateInfo = null
    this.platformUpdater?.resetDownloadState?.()
    this.sendUpdateEvent('update-download-cancelled', undefined)
    return {
      success: true,
      status: this.getDownloadStatus()
    }
  }

  /**
   * 获取或刷新当前仓库与“我的源”“官方源”之间的版本差距及合并影响评估。
   * @param forceRefresh 为 true 时跳过短时缓存重新拉取远端数据。
   * @returns 完整的双源对比与合并影响分析结果。
   */
  public async analyzeForkUpdate(forceRefresh = false): Promise<ForkUpdateAnalysis> {
    if (
      !forceRefresh &&
      this.latestAnalysis &&
      Date.now() - this.latestAnalysis.checkedAt < 60_000
    ) {
      return this.latestAnalysis
    }
    const prefs = this.getUpdatePreferences()
    const combined = await checkForkAndOfficialUpdates(
      prefs.preferredUpdateSource,
      this.shouldIncludePrerelease()
    )
    this.latestAnalysis = combined.analysis
    return combined.analysis
  }

  /**
   * 根据双源检测结果和用户偏好，构建本次应当提示的平台更新载荷。
   * @param combined 双源版本检测及合并影响评估结果。
   * @param prefs 当前设备的更新偏好配置。
   * @returns 存在需要提示的新版本时返回更新载荷，否则返回 null。
   */
  private resolvePrimaryUpdateInfo(
    combined: CombinedUpdateCheckResult,
    prefs: UpdatePreferences
  ): PlatformUpdateInfo | null {
    const { analysis, myRelease, officialPlatformInfo, mergedSources } = combined
    const myHasUpdate = analysis.mySource.hasUpdate && Boolean(myRelease.latestVersion)
    const officialHasUpdate =
      !prefs.ignoreOfficialUpdateNotice &&
      analysis.officialSource.hasNewerThanBase &&
      Boolean(analysis.officialSource.latestVersion)

    if (!myHasUpdate && !officialHasUpdate) {
      return null
    }

    // 默认优先采用我的源；仅在用户偏好官方源且官方有新版本，或我的源暂无新版本时才主推官方源。
    const useOfficialAsPrimary =
      (prefs.preferredUpdateSource === 'official' && officialHasUpdate) || !myHasUpdate

    if (!useOfficialAsPrimary && myRelease.latestVersion) {
      return {
        version: myRelease.latestVersion,
        currentVersion: analysis.currentVersion,
        changelog:
          myRelease.changelog ||
          `### 我的源 (${FORK_OWNER}/${FORK_REPO}) v${myRelease.latestVersion}`,
        releaseUrl: myRelease.releaseUrl || FORK_GITHUB_LATEST_RELEASE_URL,
        downloadUrl: myRelease.assetUrl || myRelease.releaseUrl,
        feedUrl: getForkReleaseFeedUrl(myRelease.latestVersion),
        manualDownloadRequired: false,
        origin: 'mine',
        preferredOrigin: 'mine',
        sources: mergedSources,
        forkAnalysis: analysis
      }
    }

    const officialVersion =
      officialPlatformInfo?.version ?? analysis.officialSource.latestVersion ?? ''
    const officialChangelog =
      officialPlatformInfo?.changelog ||
      analysis.officialSource.changelog ||
      `### 官方源 v${officialVersion}`
    const officialReleaseUrl =
      officialPlatformInfo?.releaseUrl ||
      analysis.officialSource.releaseUrl ||
      GITHUB_LATEST_RELEASE_URL
    const hasInAppOfficialSource = mergedSources.some(
      (source) => source.origin === 'official' && isInAppUpdateSource(source)
    )

    return {
      ...(officialPlatformInfo ?? {}),
      version: officialVersion,
      currentVersion: analysis.currentVersion,
      changelog: officialChangelog,
      releaseUrl: officialReleaseUrl,
      manualDownloadRequired:
        officialPlatformInfo?.manualDownloadRequired ?? !hasInAppOfficialSource,
      origin: 'official',
      preferredOrigin: 'official',
      sources: mergedSources,
      forkAnalysis: analysis
    }
  }

  /**
   * 启用或停止自动检查更新，并将最新开关状态同步给主窗口。
   * @param enabled 是否启用自动检查更新
   * @returns 无返回值
   */
  public setAutoCheck(enabled: boolean): void {
    this.autoCheckEnabled = enabled
    this.sendUpdateEvent('auto-check-update-changed', enabled)
    if (!enabled) {
      if (this.autoCheckTimer) clearInterval(this.autoCheckTimer)
      this.autoCheckTimer = null
      return
    }
    // 自动检查独立请求更新目录，E2E 不启动后台网络请求。
    if (process.env.ZTOOLS_E2E === '1' || this.autoCheckTimer) return
    void this.checkAutomatically()
    this.autoCheckTimer = setInterval(() => {
      void this.checkAutomatically()
    }, AUTO_CHECK_INTERVAL_MS)
  }

  /**
   * 通过与手动检查相同的设备请求查询版本，避免重复自动提示。
   * @returns 更新检查处理完成后的 Promise。
   */
  private async checkAutomatically(): Promise<void> {
    if (!this.autoCheckEnabled || this.autoCheckInFlight) return
    this.autoCheckInFlight = true
    try {
      const prefs = this.getUpdatePreferences()
      const combined = await checkForkAndOfficialUpdates(
        prefs.preferredUpdateSource,
        this.shouldIncludePrerelease()
      )
      this.latestAnalysis = combined.analysis
      if (!this.autoCheckEnabled) return

      const info = this.resolvePrimaryUpdateInfo(combined, prefs)
      const notifyKey = info ? `${info.origin ?? 'official'}:${info.version}` : ''
      if (!info || notifyKey === this.lastAutoNotifiedVersion) return

      // 请求期间若偏好发生变更（如勾选了关闭官方新版本提示），不再弹出旧官方通知。
      const latestPrefs = this.getUpdatePreferences()
      if (!this.autoCheckEnabled) return
      if (info.origin === 'official' && latestPrefs.ignoreOfficialUpdateNotice) return

      this.lastAutoNotifiedVersion = notifyKey
      this.showAvailableUpdate(info)
    } catch (error) {
      console.error('[Updater] 自动检查更新失败:', error)
    } finally {
      this.autoCheckInFlight = false
    }
  }

  private getDownloadStatus(): ReturnType<PlatformUpdaterService['getDownloadStatus']> & {
    hasUpdate: boolean
    origin?: UpdateOrigin
    currentVersion?: string
  } {
    const status = this.platformUpdater?.getDownloadStatus() ?? {
      hasDownloaded: false,
      status: 'idle'
    }
    const info = this.downloadedUpdateInfo ?? this.availableUpdateInfo
    return {
      ...status,
      hasUpdate: Boolean(info),
      origin: info?.origin,
      currentVersion: info?.currentVersion ?? app.getVersion(),
      version: status.version ?? info?.version,
      changelog: status.changelog ?? info?.changelog,
      status: status.hasDownloaded ? 'downloaded' : info ? 'available' : status.status
    }
  }

  /**
   * 安装已下载的更新，开发环境则显示不支持升级的提示。
   * @returns 安装流程启动结果。
   */
  private async installDownloadedUpdate(): Promise<{
    success: boolean
    migrationRequired?: boolean
    error?: string
  }> {
    // 任何安装入口都不得在未打包运行时替换开发中的应用。
    if (!app.isPackaged) return this.rejectDevelopmentUpdate()

    await this.initializationPromise
    if (!this.platformUpdater) return { success: false, error: '更新器尚未初始化' }
    return this.platformUpdater.installDownloadedUpdate()
  }

  /**
   * 停止后台更新检查并释放平台更新器。
   * @returns 无返回值。
   */
  public cleanup(): void {
    this.autoCheckEnabled = false
    if (this.autoCheckTimer) clearInterval(this.autoCheckTimer)
    this.autoCheckTimer = null
    this.platformUpdater?.cleanup()
  }

  public async checkUpdate(): Promise<
    Awaited<ReturnType<PlatformUpdaterService['checkForUpdates']>>
  > {
    const currentVersion = app.getVersion()
    try {
      const prefs = this.getUpdatePreferences()
      const combined = await checkForkAndOfficialUpdates(
        prefs.preferredUpdateSource,
        this.shouldIncludePrerelease()
      )
      this.latestAnalysis = combined.analysis

      // 两个更新源均未获取到任何版本信息时，按检查失败处理。
      if (
        !combined.myRelease.latestVersion &&
        !combined.officialServerUpdate &&
        !combined.analysis.officialSource.latestVersion
      ) {
        return {
          success: false,
          status: 'error',
          hasUpdate: false,
          currentVersion,
          forkAnalysis: combined.analysis,
          error:
            combined.myRelease.error || combined.analysis.officialSource.error || '检查更新失败'
        }
      }

      const info = this.resolvePrimaryUpdateInfo(combined, prefs)
      if (!info) {
        return {
          success: true,
          status: 'not-available',
          hasUpdate: false,
          currentVersion,
          latestVersion:
            combined.myRelease.latestVersion ??
            combined.officialServerUpdate?.latestVersion ??
            combined.analysis.officialSource.latestVersion ??
            undefined,
          forkAnalysis: combined.analysis
        }
      }

      this.showAvailableUpdate(info)
      return {
        success: true,
        status: 'available',
        hasUpdate: true,
        currentVersion,
        latestVersion: info.version,
        updateInfo: info,
        forkAnalysis: combined.analysis
      }
    } catch (error) {
      return {
        success: false,
        status: 'error',
        hasUpdate: false,
        currentVersion,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  }

  /**
   * 使用用户选择的下载渠道执行当前更新，人工渠道直接在浏览器中打开。
   * @param sourceID 用户在更新窗口中选择的下载源标识；未提供时沿用默认渠道。
   * @returns 更新流程启动结果。
   */
  public async startUpdate(sourceID?: number): Promise<{
    success: boolean
    cancelled?: boolean
    openedExternal?: boolean
    migrationRequired?: boolean
    error?: string
  }> {
    const updateInfo = this.availableUpdateInfo ?? this.downloadedUpdateInfo
    if (!updateInfo) return { success: false, error: '没有可用的更新' }

    // 渠道由服务端或“我的源”组合下发，手动渠道无需初始化安装器即可跳转浏览器。
    const selectedSource =
      typeof sourceID === 'number'
        ? updateInfo.sources?.find((source) => source.id === sourceID)
        : undefined
    if (typeof sourceID === 'number' && !selectedSource) {
      return { success: false, error: '下载渠道不存在' }
    }

    // 防止在我的源尚无更高版本时误下载同版本或旧版本。
    const currentVersion = app.getVersion()
    if (
      selectedSource?.origin === 'mine' &&
      selectedSource.version &&
      compareSemverVersions(selectedSource.version, currentVersion) <= 0
    ) {
      return {
        success: false,
        error: `我的源当前 v${selectedSource.version} 已是最新版本，如需更新官方版本请切换至官方源`
      }
    }

    if (selectedSource && !isInAppUpdateSource(selectedSource)) {
      return this.openDownloadSource(selectedSource.id)
    }
    if (!selectedSource && updateInfo.manualDownloadRequired) {
      const manualSource = updateInfo.sources?.find((source) => !isInAppUpdateSource(source))
      if (!manualSource) return { success: false, error: '没有可用的手动下载地址' }
      return this.openDownloadSource(manualSource.id)
    }

    // 应用内下载安装必须依赖打包产物和已经初始化的平台更新器。
    if (!app.isPackaged) return this.rejectDevelopmentUpdate()
    await this.initializationPromise
    if (!this.platformUpdater) return { success: false, error: '更新器尚未初始化' }
    const selectedUpdateInfo: PlatformUpdateInfo = selectedSource
      ? {
          ...updateInfo,
          version: selectedSource.version ?? updateInfo.version,
          changelog: selectedSource.changelog ?? updateInfo.changelog,
          downloadUrl: selectedSource.downloadUrl,
          feedUrl: selectedSource.feedUrl,
          releaseUrl: selectedSource.releaseUrl ?? updateInfo.releaseUrl,
          origin: selectedSource.origin ?? updateInfo.origin,
          manualDownloadRequired: false
        }
      : updateInfo
    return this.platformUpdater.startUpdate(selectedUpdateInfo)
  }

  /**
   * 取消平台更新器当前正在执行的下载。
   * @returns 取消请求处理结果。
   */
  public async cancelUpdate(): Promise<{
    success: boolean
    cancelled?: boolean
    error?: string
  }> {
    await this.initializationPromise
    if (!this.platformUpdater) return { success: false, error: '更新器尚未初始化' }
    return this.platformUpdater.cancelUpdate()
  }

  /**
   * 使用系统浏览器打开当前版本中已由服务端或“我的源”登记的下载源。
   * @param sourceID 下载源标识。
   * @returns 浏览器是否成功打开对应 HTTPS 地址（成功时附带 openedExternal 标记）。
   */
  private async openDownloadSource(
    sourceID: number
  ): Promise<{ success: boolean; openedExternal?: boolean; error?: string }> {
    const info = this.availableUpdateInfo ?? this.downloadedUpdateInfo
    const source = info?.sources?.find((item) => item.id === sourceID)
    if (!source) return { success: false, error: '下载地址不存在' }
    try {
      const target = new URL(source.downloadUrl)
      if (target.protocol !== 'https:') return { success: false, error: '下载地址不安全' }
      await shell.openExternal(target.toString())
      return { success: true, openedExternal: true }
    } catch {
      return { success: false, error: '无法打开下载地址' }
    }
  }

  /**
   * 显示开发环境不支持升级的原生提示并返回失败结果。
   * @returns 固定的开发环境升级失败结果。
   */
  private async rejectDevelopmentUpdate(): Promise<{ success: false; error: string }> {
    const error = '开发环境不支持升级'
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'ZTools',
      message: error,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true
    }
    const parentWindow =
      this.updateWindow && !this.updateWindow.isDestroyed() ? this.updateWindow : this.mainWindow

    // 优先绑定更新窗口，避免原生对话框被其他窗口遮挡。
    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, options)
    } else {
      await dialog.showMessageBox(options)
    }

    return { success: false, error }
  }

  private showUpdateWindow(): { success: boolean; error?: string } {
    if (!this.availableUpdateInfo && !this.downloadedUpdateInfo) {
      return { success: false, error: '没有可用的更新' }
    }
    this.createUpdateWindow()
    return { success: true }
  }

  private applyMaterialToUpdateWindow(win: BrowserWindow): void {
    try {
      const settings = databaseAPI.dbGet('settings-general')
      const material = settings?.windowMaterial || getDefaultWindowMaterial()
      applyWindowMaterial(win, material)
    } catch (error) {
      console.error('[Updater] 应用窗口材质失败:', error)
    }
  }

  /**
   * 使用系统默认浏览器打开更新日志中的 HTTP(S) 链接。
   * @param url 更新日志请求打开的链接。
   * @returns 无返回值。
   */
  private openExternalUpdateLink(url: string): void {
    try {
      const target = new URL(url)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return

      // 外部打开失败不应影响更新窗口本身，记录错误供诊断即可。
      void shell.openExternal(target.toString()).catch((error) => {
        console.error('[Updater] 使用默认浏览器打开更新日志链接失败:', error)
      })
    } catch {
      console.warn('[Updater] 忽略无效的更新日志链接:', url)
    }
  }

  /**
   * 阻止更新日志链接接管更新窗口，并将可信的网页链接交给系统浏览器。
   * @param webContents 更新窗口的 WebContents。
   * @returns 无返回值。
   */
  private registerExternalLinkInterceptor(webContents: WebContents): void {
    webContents.on('will-navigate', (event, url) => {
      // 更新窗口只承载本地界面，任何页面导航都不得替换当前更新流程。
      event.preventDefault()
      this.openExternalUpdateLink(url)
    })

    webContents.setWindowOpenHandler(({ url }) => {
      // 新窗口链接同样统一交给系统浏览器，且不创建额外 Electron 窗口。
      this.openExternalUpdateLink(url)
      return { action: 'deny' }
    })
  }

  /**
   * 创建并加载居中的更新窗口，已有窗口则直接显示并聚焦。
   * @returns 无返回值。
   */
  private createUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) {
      this.updateWindow.show()
      this.updateWindow.focus()
      return
    }

    const width = 500
    const height = 450
    const { workArea } = screen.getPrimaryDisplay()
    const windowConfig: Electron.BrowserWindowConstructorOptions = {
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      hasShadow: true,
      type: 'panel',
      webPreferences: {
        preload: getPreloadPath(),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    }

    if (process.platform === 'darwin') {
      windowConfig.transparent = true
      windowConfig.vibrancy = 'fullscreen-ui'
    } else if (process.platform === 'win32') {
      windowConfig.backgroundColor = '#00000000'
    }

    this.updateWindow = new BrowserWindow(windowConfig)
    this.registerExternalLinkInterceptor(this.updateWindow.webContents)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void this.updateWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/updater.html`)
    } else {
      void this.updateWindow.loadFile(getRendererPath('updater.html'))
    }

    if (process.platform === 'win32') this.applyMaterialToUpdateWindow(this.updateWindow)
    this.updateWindow.once('ready-to-show', () => this.updateWindow?.show())
    this.updateWindow.on('closed', () => {
      this.updateWindow = null
    })
  }

  private closeUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) this.updateWindow.close()
  }

  /**
   * 最小化当前更新窗口，让更新流程在后台继续运行。
   * @returns 无返回值。
   */
  private minimizeUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) this.updateWindow.minimize()
  }
}

export default new UpdaterAPI()
