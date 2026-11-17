import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events')
  const emitter = new EventEmitter() as any
  emitter.logger = null
  emitter.autoDownload = false
  emitter.autoInstallOnAppQuit = false
  emitter.allowPrerelease = false
  emitter.currentVersion = { prerelease: [] }
  emitter.setFeedURL = vi.fn()
  emitter.checkForUpdates = vi.fn()
  emitter.downloadUpdate = vi.fn()
  emitter.quitAndInstall = vi.fn()

  return {
    autoUpdater: emitter
  }
})

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.1'),
    isPackaged: true
  }
}))

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } }
  }
}))

vi.mock('builder-util-runtime', () => ({
  CancellationToken: class {
    cancel = vi.fn()
    dispose = vi.fn()
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mocks.autoUpdater,
  NsisUpdater: vi.fn()
}))

import { ElectronUpdaterService } from '../../src/main/api/electronUpdater'

describe('ElectronUpdaterService 切源与重置下载状态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.autoUpdater.removeAllListeners()
    mocks.autoUpdater.allowPrerelease = false
  })

  it('已下载某个源后切换新 feedUrl 应允许重新拉取并安装，resetDownloadState 应清回闲置态', async () => {
    const callbacks = {
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    }
    const service = new ElectronUpdaterService(callbacks)

    let activeVersion = '3.3.0'
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => ({
      updateInfo: {
        version: activeVersion,
        releaseNotes: 'Notes',
        releaseName: activeVersion
      }
    }))
    mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {
      mocks.autoUpdater.emit('update-downloaded', {
        version: activeVersion,
        releaseNotes: 'Notes'
      })
    })

    // 第一次按官方源检查并下载完成（尚未触发重启安装）。
    mocks.autoUpdater.setFeedURL({ provider: 'generic', url: 'https://official.example/feed' })
    const checked = await service.checkForUpdates(false)
    expect(checked.hasUpdate).toBe(true)
    const first = await service.downloadUpdate(false)
    expect(first.success).toBe(true)
    expect(service.getDownloadStatus()).toMatchObject({
      hasDownloaded: true,
      status: 'downloaded'
    })

    // 通过 resetDownloadState 清空先前已下载缓存。
    service.resetDownloadState()
    expect(service.getDownloadStatus()).toMatchObject({
      hasDownloaded: false,
      status: 'idle'
    })

    // 紧接着切到“我的源”另一个 feedUrl 与版本，应重新执行 setFeedURL、check 和 downloadUpdate。
    activeVersion = '0.0.2'
    const second = await service.downloadAndInstall({
      version: '0.0.2',
      changelog: 'Fork release',
      feedUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2'
    })
    expect(second.success).toBe(true)
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2'
    })
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('不手动调用 resetDownloadState 直接更换 feedUrl 时也应绕过旧 downloaded 短路', async () => {
    const service = new ElectronUpdaterService({
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    })

    let activeVersion = '3.3.0'
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => ({
      updateInfo: { version: activeVersion, releaseNotes: '' }
    }))
    mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {
      mocks.autoUpdater.emit('update-downloaded', { version: activeVersion, releaseNotes: '' })
    })

    await service.downloadAndInstall({
      version: '3.3.0',
      changelog: '',
      feedUrl: 'https://official.example/feed-a'
    })

    activeVersion = '0.0.3-beta.1'
    const res = await service.downloadAndInstall({
      version: '0.0.3-beta.1',
      changelog: '',
      feedUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.3-beta.1'
    })

    expect(res.success).toBe(true)
    expect(mocks.autoUpdater.allowPrerelease).toBe(true)
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
  })
})
