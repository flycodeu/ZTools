import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const send = vi.fn()
  const platformUpdater = {
    initialize: vi.fn(() => Promise.resolve()),
    cleanup: vi.fn(),
    getDownloadStatus: vi.fn(() => ({ hasDownloaded: false, status: 'idle' })),
    checkForUpdates: vi.fn(),
    startUpdate: vi.fn(async () => ({ success: true, openedExternal: true })),
    cancelUpdate: vi.fn(async () => ({ success: true, cancelled: true })),
    resetDownloadState: vi.fn(),
    installDownloadedUpdate: vi.fn(async () => ({ success: true }))
  }
  const latestWindow = { current: null as any }

  return {
    send,
    ipcHandle: vi.fn(),
    ipcOn: vi.fn(),
    shellOpenExternal: vi.fn(async () => undefined),
    dialogShowMessageBox: vi.fn(),
    platformUpdater,
    latestWindow,
    checkForkAndOfficialUpdates: vi.fn(),
    browserWindow: vi.fn(function () {
      const win = {
        webContents: {
          send: vi.fn(),
          on: vi.fn(),
          setWindowOpenHandler: vi.fn()
        },
        once: vi.fn(),
        on: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        close: vi.fn(),
        minimize: vi.fn(),
        loadFile: vi.fn(async () => undefined),
        loadURL: vi.fn(async () => undefined),
        isDestroyed: vi.fn(() => false)
      }
      latestWindow.current = win
      return win
    })
  }
})

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.1'),
    isPackaged: true
  },
  BrowserWindow: mocks.browserWindow,
  dialog: {
    showMessageBox: mocks.dialogShowMessageBox
  },
  ipcMain: {
    handle: mocks.ipcHandle,
    on: mocks.ipcOn
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }))
  },
  shell: {
    openExternal: mocks.shellOpenExternal
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

vi.mock('../../src/main/utils/appBundlePath', () => ({
  getPreloadPath: vi.fn(() => '/mock/preload.js'),
  getRendererPath: vi.fn((file: string) => `/mock/${file}`)
}))

vi.mock('@platform-updater', () => ({
  default: vi.fn(() => mocks.platformUpdater)
}))

vi.mock('../../src/main/api/shared/database.js', () => {
  const store: Record<string, any> = {}
  return {
    default: {
      dbGet: vi.fn((key: string) => store[key] ?? null),
      dbPut: vi.fn((key: string, value: any) => {
        store[key] = value
        return { ok: true }
      }),
      __store: store
    }
  }
})

vi.mock('../../src/main/managers/windowManager', () => ({
  default: {
    setQuitting: vi.fn()
  }
}))

vi.mock('../../src/main/utils/windowUtils.js', () => ({
  applyWindowMaterial: vi.fn(),
  getDefaultWindowMaterial: vi.fn(() => 'none')
}))

vi.mock('../../src/main/api/forkUpdateAnalyzer', () => ({
  checkForkAndOfficialUpdates: mocks.checkForkAndOfficialUpdates
}))

import databaseAPI from '../../src/main/api/shared/database.js'
import { UpdaterAPI } from '../../src/main/api/updater'
import {
  FORK_GITHUB_LATEST_RELEASE_URL,
  GITHUB_LATEST_RELEASE_URL,
  MY_UPDATE_SOURCE_ID
} from '../../src/shared/updateSource'

describe('UpdaterAPI 多源切换、偏好配置与外部打开处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('ZTOOLS_E2E', '1')
    const store = (databaseAPI as any).__store as Record<string, any>
    delete store['settings-general']
    mocks.latestWindow.current = null
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('应默认偏好我的源且允许关闭官方新版本提示并持久化到设置', async () => {
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: mocks.send } } as any)

    expect(updater.getUpdatePreferences()).toEqual({
      preferredUpdateSource: 'mine',
      ignoreOfficialUpdateNotice: false
    })

    const saved = updater.setUpdatePreferences({ ignoreOfficialUpdateNotice: true })
    expect(saved).toEqual({
      preferredUpdateSource: 'mine',
      ignoreOfficialUpdateNotice: true
    })
    expect(databaseAPI.dbPut).toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith('update-preferences-changed', saved)

    mocks.checkForkAndOfficialUpdates.mockResolvedValue({
      analysis: {
        currentVersion: '0.0.1',
        upstreamBaseVersion: '3.2.0',
        upstreamBaseCommit: 'a4d0459',
        mySource: {
          repo: 'flycodeu/ZTools',
          latestVersion: '0.0.1',
          hasUpdate: false,
          releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL,
          changelog: ''
        },
        officialSource: {
          repo: 'ZToolsCenter/ZTools',
          latestVersion: '3.3.0',
          hasNewerThanBase: true,
          hasNewerThanLocal: true,
          releaseUrl: GITHUB_LATEST_RELEASE_URL,
          changelog: '官方 3.3.0'
        },
        mergeImpact: {
          level: 'low',
          canDirectMerge: true,
          summary: '可直接合并',
          reasons: [],
          upstreamCommitsAhead: 5,
          upstreamCommitsBehind: 0,
          forkCommitsAhead: 1,
          forkChangedFiles: [],
          upstreamChangedFiles: [],
          overlapFiles: [],
          forkOnlyIsolatedChanges: true,
          upstreamCoreOrDependencyChanged: false
        },
        checkedAt: Date.now()
      },
      myRelease: {
        repo: 'flycodeu/ZTools',
        latestVersion: '0.0.1',
        changelog: '',
        releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL
      },
      officialServerUpdate: {
        available: true,
        latestVersion: '3.3.0',
        releaseNotes: '官方 3.3.0',
        publishedAt: Date.now()
      },
      officialPlatformInfo: {
        version: '3.3.0',
        changelog: '官方 3.3.0',
        releaseUrl: GITHUB_LATEST_RELEASE_URL,
        sources: []
      },
      mergedSources: []
    })

    const result = await updater.checkUpdate()
    expect(result.hasUpdate).toBe(false)
    expect(mocks.browserWindow).not.toHaveBeenCalled()
    updater.cleanup()
  })

  it('我的源已有更新时应优先推送我的源，并支持重置下载缓存及拦截同版本重复下载', async () => {
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: mocks.send } } as any)

    mocks.checkForkAndOfficialUpdates.mockResolvedValue({
      analysis: {
        currentVersion: '0.0.1',
        upstreamBaseVersion: '3.2.0',
        upstreamBaseCommit: 'a4d0459',
        mySource: {
          repo: 'flycodeu/ZTools',
          latestVersion: '0.0.2',
          hasUpdate: true,
          releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL,
          changelog: '### 我的源 0.0.2'
        },
        officialSource: {
          repo: 'ZToolsCenter/ZTools',
          latestVersion: '3.3.0',
          hasNewerThanBase: true,
          hasNewerThanLocal: true,
          releaseUrl: GITHUB_LATEST_RELEASE_URL,
          changelog: '### 官方 3.3.0'
        },
        mergeImpact: {
          level: 'high',
          canDirectMerge: false,
          summary: '影响较大',
          reasons: [],
          upstreamCommitsAhead: 5,
          upstreamCommitsBehind: 0,
          forkCommitsAhead: 2,
          forkChangedFiles: [],
          upstreamChangedFiles: [],
          overlapFiles: ['src/main/api/updater.ts'],
          forkOnlyIsolatedChanges: false,
          upstreamCoreOrDependencyChanged: false
        },
        checkedAt: Date.now()
      },
      myRelease: {
        repo: 'flycodeu/ZTools',
        latestVersion: '0.0.2',
        changelog: '### 我的源 0.0.2',
        releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL,
        assetUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2/setup.exe'
      },
      officialServerUpdate: null,
      officialPlatformInfo: null,
      mergedSources: [
        {
          id: MY_UPDATE_SOURCE_ID,
          platformName: '我的源 (flycodeu/ZTools)',
          downloadUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2/setup.exe',
          isDirect: true,
          feedUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2',
          origin: 'mine',
          version: '0.0.2',
          changelog: '### 我的源 0.0.2',
          releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL
        },
        {
          id: 1,
          platformName: 'GitHub (官方 ZToolsCenter)',
          downloadUrl: GITHUB_LATEST_RELEASE_URL,
          isDirect: false,
          origin: 'official',
          version: '3.3.0',
          changelog: '### 官方 3.3.0',
          releaseUrl: GITHUB_LATEST_RELEASE_URL
        }
      ]
    })

    const checkResult = await updater.checkUpdate()
    expect(checkResult.hasUpdate).toBe(true)
    expect(checkResult.latestVersion).toBe('0.0.2')
    expect(checkResult.updateInfo?.origin).toBe('mine')

    // 切至我的源触发平台更新器，需携带我的源的 feedUrl 并透传 openedExternal。
    const startMine = await updater.startUpdate(MY_UPDATE_SOURCE_ID)
    expect(startMine).toEqual({ success: true, openedExternal: true })
    expect(mocks.platformUpdater.startUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.0.2',
        feedUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2',
        origin: 'mine'
      })
    )

    // 切换渠道前重置下载状态，应调用平台 resetDownloadState 且保留当前更新选项。
    const resetResult = updater.resetDownloadState()
    expect(resetResult.success).toBe(true)
    expect(mocks.platformUpdater.resetDownloadState).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledWith('update-download-cancelled', undefined)

    // 切换至非直链官方渠道（GitHub），应打开外部浏览器并返回 openedExternal: true。
    const startOfficialManual = await updater.startUpdate(1)
    expect(startOfficialManual).toEqual({ success: true, openedExternal: true })
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith(GITHUB_LATEST_RELEASE_URL)
    updater.cleanup()
  })

  it('当“我的源”远端版本不高于本地版本时，startUpdate 选择我的源应明确拒绝重复下载', async () => {
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: mocks.send } } as any)

    mocks.checkForkAndOfficialUpdates.mockResolvedValue({
      analysis: {
        currentVersion: '0.0.1',
        upstreamBaseVersion: '3.2.0',
        upstreamBaseCommit: 'a4d0459',
        mySource: {
          repo: 'flycodeu/ZTools',
          latestVersion: '0.0.1',
          hasUpdate: false,
          releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL,
          changelog: ''
        },
        officialSource: {
          repo: 'ZToolsCenter/ZTools',
          latestVersion: '3.3.0',
          hasNewerThanBase: true,
          hasNewerThanLocal: true,
          releaseUrl: GITHUB_LATEST_RELEASE_URL,
          changelog: '官方 3.3.0'
        },
        mergeImpact: {
          level: 'low',
          canDirectMerge: true,
          summary: '可直接合并',
          reasons: [],
          upstreamCommitsAhead: 5,
          upstreamCommitsBehind: 0,
          forkCommitsAhead: 1,
          forkChangedFiles: [],
          upstreamChangedFiles: [],
          overlapFiles: [],
          forkOnlyIsolatedChanges: true,
          upstreamCoreOrDependencyChanged: false
        },
        checkedAt: Date.now()
      },
      myRelease: {
        repo: 'flycodeu/ZTools',
        latestVersion: '0.0.1',
        changelog: '',
        releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL
      },
      officialServerUpdate: null,
      officialPlatformInfo: null,
      mergedSources: [
        {
          id: MY_UPDATE_SOURCE_ID,
          platformName: '我的源 (flycodeu/ZTools)',
          downloadUrl: FORK_GITHUB_LATEST_RELEASE_URL,
          isDirect: true,
          feedUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.1',
          origin: 'mine',
          version: '0.0.1',
          changelog: '',
          releaseUrl: FORK_GITHUB_LATEST_RELEASE_URL
        },
        {
          id: 1,
          platformName: 'GitHub (官方 ZToolsCenter)',
          downloadUrl: GITHUB_LATEST_RELEASE_URL,
          isDirect: false,
          origin: 'official',
          version: '3.3.0',
          changelog: '官方 3.3.0',
          releaseUrl: GITHUB_LATEST_RELEASE_URL
        }
      ]
    })

    await updater.checkUpdate()
    const rejectMine = await updater.startUpdate(MY_UPDATE_SOURCE_ID)
    expect(rejectMine.success).toBe(false)
    expect(rejectMine.error).toContain('已是最新版本')
    updater.cleanup()
  })
})
