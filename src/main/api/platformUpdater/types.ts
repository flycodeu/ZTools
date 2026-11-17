import type { ProgressInfo } from 'electron-updater'
import type { ForkUpdateAnalysis, UpdateOrigin } from '../../../shared/updateSource'

export interface PlatformUpdateInfo {
  version: string
  currentVersion?: string
  changelog: string
  releaseNotes?: string
  downloadUrl?: string
  manualDownloadRequired?: boolean
  migrationRequired?: boolean
  releaseUrl?: string
  feedUrl?: string
  origin?: UpdateOrigin
  sources?: UpdateDownloadSource[]
  preferredOrigin?: UpdateOrigin
  forkAnalysis?: ForkUpdateAnalysis
}

export interface UpdateDownloadSource {
  id: number
  platformName: string
  downloadUrl: string
  isDirect: boolean
  feedUrl?: string
  origin?: UpdateOrigin
  version?: string
  changelog?: string
  releaseUrl?: string
}

export interface PlatformUpdateResult {
  success?: boolean
  status?: string
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  updateInfo?: PlatformUpdateInfo
  migrationRequired?: boolean
  migrationReasons?: string[]
  releaseUrl?: string
  forkAnalysis?: ForkUpdateAnalysis
  error?: string
}

export interface PlatformUpdateActionResult {
  success: boolean
  cancelled?: boolean
  openedExternal?: boolean
  migrationRequired?: boolean
  error?: string
}

export interface PlatformDownloadStatus {
  hasDownloaded: boolean
  version?: string
  changelog?: string
  status?: string
}

export interface PlatformUpdaterCallbacks {
  onDownloadStart: (info: { version: string }) => void
  onDownloadProgress: (info: ProgressInfo) => void
  onDownloadCancelled: () => void
  onDownloaded: (info: PlatformUpdateInfo, showWindow: boolean) => void
  onDownloadFailed: (error: string) => void
  onBeforeInstall: () => void
}

export interface PlatformUpdaterService {
  initialize(): Promise<void>
  checkForUpdates(downloadWhenAvailable: boolean): Promise<PlatformUpdateResult>
  startUpdate(updateInfo?: PlatformUpdateInfo): Promise<PlatformUpdateActionResult>
  cancelUpdate(): Promise<PlatformUpdateActionResult> | PlatformUpdateActionResult
  resetDownloadState?(): void
  installDownloadedUpdate(): Promise<PlatformUpdateActionResult> | PlatformUpdateActionResult
  getDownloadStatus(): PlatformDownloadStatus
  cleanup(): void
}

export type CreatePlatformUpdater = (callbacks: PlatformUpdaterCallbacks) => PlatformUpdaterService
