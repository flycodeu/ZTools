import crypto from 'crypto'
import { EventEmitter } from 'events'
import os from 'os'
import type LmdbDatabase from '../lmdb/index'
import type { DbDoc } from '../lmdb/types'
import type { FullChangeEntry } from './types'
import { normalizeWebdavRemoteDir, normalizeWebdavServerUrl } from '../../../shared/syncServerUrl'
import type {
  ISyncEngine,
  SyncConfig,
  SyncState,
  WebdavBlobManifestEntry,
  WebdavSyncManifest
} from './types'
import { SyncCheckpoint, SyncCheckpointStore } from './syncCheckpointStore'
import type { SyncRetryStatus } from './syncTaskStore'
import { ACCOUNT_SYNC_PREFIXES, isAccountSyncDoc } from '../storage/storageRouting'
import { WebdavHttpClient, WebdavHttpError } from './webdavHttpClient'

const MANIFEST_REL_PATH = 'manifest.json'
const MANIFEST_SCHEMA_VERSION = 1
const LOCAL_DEBOUNCE_MS = 2000
const MIN_POLL_INTERVAL_SECONDS = 15

interface StoredDocPayload {
  _id: string
  _rev: string
  _parentRev?: string | null
  _revisionHistory?: string[]
  _deleted?: boolean
  _lastModified?: number
  doc: DbDoc | null
}

/**
 * 基于 `manifest.json` 增量索引与 WebDAV HTTP 协议的双向同步客户端，
 * 复用 LMDB revision tree 与冲突模型，支持坚果云等带子路径的 WebDAV 服务。
 */
export class WebDAVSyncClient extends EventEmitter implements ISyncEngine {
  private httpClient: WebdavHttpClient | null = null
  private config: SyncConfig | null = null
  private state: SyncState = 'disconnected'
  private checkpointStore: SyncCheckpointStore
  private checkpoint: SyncCheckpoint
  private cachedManifestEtag: string | undefined
  private baselineDocs: Record<string, string> = {}
  private pollTimer: NodeJS.Timeout | null = null
  private localDebounceTimer: NodeJS.Timeout | null = null
  private localChangeHandler: ((info: { seq: number; docId: string }) => void) | null = null
  private attachmentChangeHandler: ((info: { docId: string }) => void) | null = null
  private syncInFlight: Promise<void> | null = null
  private syncQueued = false
  private pendingForcePush = false
  private stopped = true
  private sessionGeneration = 0
  private lastError = ''

  /**
   * 构造绑定指定账号数据库的 WebDAV 同步客户端。
   * @param db 当前账号空间的 LMDB 实例。
   * @returns 初始化后的 WebDAV 同步客户端。
   */
  constructor(private db: LmdbDatabase) {
    super()
    this.checkpointStore = new SyncCheckpointStore(db)
    this.checkpoint = this.checkpointStore.load()
  }

  /**
   * 获取当前同步状态。
   * @returns 当前同步状态枚举值。
   */
  public getState(): SyncState {
    return this.state
  }

  /**
   * 获取兼容设置的重试/待处理队列状态摘要。
   * @returns 当前待处理队列计数及最近错误。
   */
  public getRetryStatus(): SyncRetryStatus {
    return {
      pendingPushBatches: this.syncInFlight || this.syncQueued ? 1 : 0,
      pendingUploads: 0,
      pendingDownloads: 0,
      failedPermanent: 0,
      authRequired: this.lastError.includes('认证失败') ? 1 : 0,
      lastError: this.lastError || undefined
    }
  }

  /**
   * 立即触发一次同步重试。
   * @returns 无返回值。
   */
  public retryNow(): void {
    this.performSync()
  }

  /**
   * 使用当前账号与 WebDAV 配置启动同步引擎、定时轮询及本地变更监听。
   * @param config 已通过校验的 WebDAV 同步运行配置。
   * @returns 无返回值。
   */
  public start(config: SyncConfig): void {
    this.stop()
    if (!config.enabled || !config.serverUrl || !config.username || !config.password) {
      return
    }

    try {
      this.httpClient = new WebdavHttpClient({
        serverUrl: config.serverUrl,
        remoteDir: config.remoteDir,
        username: config.username,
        password: config.password
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'WebDAV 配置无效'
      this.setState('error')
      this.emit('sync-error', this.lastError)
      return
    }

    this.config = config
    this.stopped = false
    this.sessionGeneration += 1
    this.lastError = ''
    this.cachedManifestEtag = undefined
    this.checkpoint = this.checkpointStore.load(
      config.username,
      config.deviceId || os.hostname(),
      this.httpClient.getCheckpointScopeUrl()
    )
    this.loadBaselineDocs()

    this.listenLocalChanges()
    const pollSeconds = Math.max(config.syncInterval || 30, MIN_POLL_INTERVAL_SECONDS)
    this.pollTimer = setInterval(() => {
      this.scheduleSync()
    }, pollSeconds * 1000)

    this.scheduleSync()
  }

  /**
   * 停止当前 WebDAV 同步任务、定时轮询与本地变更监听。
   * @returns 无返回值。
   */
  public stop(): void {
    this.stopped = true
    this.sessionGeneration += 1
    this.syncQueued = false
    this.pendingForcePush = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.localDebounceTimer) {
      clearTimeout(this.localDebounceTimer)
      this.localDebounceTimer = null
    }
    this.stopListeningLocalChanges()
    this.setState('disconnected')
  }

  /**
   * 立即执行一次双向 WebDAV 同步（强制跳过 ETag 304 缓存在异常后重新对齐）。
   * @returns 无返回值。
   */
  public performSync(): void {
    if (this.stopped || !this.config?.enabled || !this.httpClient) return
    this.cachedManifestEtag = undefined
    this.setState('connecting')
    this.scheduleSync()
  }

  /**
   * 强制扫描本地所有同步作用域文档，并将完整快照上传覆写至 WebDAV。
   * @returns 无返回值。
   */
  public forcePushAll(): void {
    if (this.stopped || !this.config?.enabled || !this.httpClient) {
      console.warn('[WebDAV] forcePushAll: 同步未启动')
      return
    }
    this.cachedManifestEtag = undefined
    this.pendingForcePush = true
    this.setState('connecting')
    this.scheduleSync()
  }

  /**
   * 统计当前 WebDAV 目标在本地 checkpoint 之后待同步的唯一文档数量。
   * @param config 可选的目标同步配置，缺省使用当前活动配置。
   * @returns 待推送或新目标全量首次同步的唯一文档数量。
   */
  public getPendingDocumentCount(config?: SyncConfig | null): number {
    const active = config || this.config
    const scopeUrl = this.resolveScopeUrl(active)
    const checkpoint =
      active && scopeUrl
        ? this.checkpointStore.load(active.username, active.deviceId || os.hostname(), scopeUrl)
        : this.checkpoint

    const pendingDocIds = new Set<string>()
    for (const change of this.db.getChangesSince(checkpoint.localPushSeq)) {
      if (isAccountSyncDoc(change.docId)) {
        pendingDocIds.add(change.docId)
      }
    }

    if (checkpoint.localPushSeq === 0) {
      for (const prefix of ACCOUNT_SYNC_PREFIXES) {
        for (const doc of this.db.allDocs(prefix)) {
          pendingDocIds.add(doc._id)
        }
      }
    }
    return pendingDocIds.size
  }

  /**
   * 重置当前 WebDAV 目标在本机的同步游标及远端版本基线，不删除本地文档与附件。
   * @param config 需要重置的同步配置。
   * @returns 重新排队的文档数及清理任务数。
   */
  public resetLocalSyncState(config?: SyncConfig | null): {
    documentsQueued: number
    tasksCleared: number
  } {
    const active = config || this.config
    const shouldRestart = Boolean(active?.enabled)
    this.stop()

    const scopeUrl = this.resolveScopeUrl(active)
    const uid = active?.username
    const deviceId = active?.deviceId || os.hostname()

    if (scopeUrl) {
      this.checkpoint = this.checkpointStore.reset(uid, deviceId, scopeUrl)
    }
    this.baselineDocs = {}
    this.cachedManifestEtag = undefined
    this.saveBaselineDocs(scopeUrl, uid, deviceId)

    const documentsQueued = this.getPendingDocumentCount(active)
    if (active && shouldRestart) {
      this.start(active)
    }
    return { documentsQueued, tasksCleared: 0 }
  }

  private setState(state: SyncState): void {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  private scheduleSync(): void {
    if (this.stopped || !this.config?.enabled || !this.httpClient) return
    if (this.syncInFlight) {
      this.syncQueued = true
      return
    }
    const generation = this.sessionGeneration
    let cycleSucceeded = false
    this.syncInFlight = this.runSyncCycle(generation)
      .then((completed) => {
        cycleSucceeded = completed
      })
      .catch((error) => {
        if (this.stopped || generation !== this.sessionGeneration) return
        const msg = error instanceof Error ? error.message : String(error)
        this.lastError = msg
        console.error('[WebDAV] 同步异常:', msg)
        this.setState('error')
        this.emit('sync-error', msg)
        this.emit('retry-status', this.getRetryStatus())
      })
      .finally(() => {
        this.syncInFlight = null
        if (this.stopped || generation !== this.sessionGeneration) return
        if (this.syncQueued) {
          this.syncQueued = false
          setImmediate(() => this.scheduleSync())
          return
        }
        // 仅在全部排队任务完成后再标记为 live，避免前端提前收到完成信号。
        if (cycleSucceeded) {
          this.lastError = ''
          this.setState('live')
          this.emit('retry-status', this.getRetryStatus())
        }
      })
  }

  private listenLocalChanges(): void {
    this.stopListeningLocalChanges()
    this.localChangeHandler = (info) => {
      if (!isAccountSyncDoc(info.docId)) return
      this.scheduleDebouncedLocalSync()
    }
    this.attachmentChangeHandler = (info) => {
      if (!isAccountSyncDoc(info.docId)) return
      this.scheduleDebouncedLocalSync()
    }
    this.db.on('change', this.localChangeHandler)
    this.db.on('attachment-added', this.attachmentChangeHandler)
  }

  private stopListeningLocalChanges(): void {
    if (this.localChangeHandler) {
      this.db.removeListener('change', this.localChangeHandler)
      this.localChangeHandler = null
    }
    if (this.attachmentChangeHandler) {
      this.db.removeListener('attachment-added', this.attachmentChangeHandler)
      this.attachmentChangeHandler = null
    }
  }

  private scheduleDebouncedLocalSync(): void {
    if (this.stopped) return
    if (this.localDebounceTimer) {
      clearTimeout(this.localDebounceTimer)
    }
    this.localDebounceTimer = setTimeout(() => {
      this.localDebounceTimer = null
      this.scheduleSync()
    }, LOCAL_DEBOUNCE_MS)
  }

  /**
   * 执行一次完整的拉取与增量推送周期，通过 ETag 与 baseline 识别并发修改并保留冲突分支。
   * @returns 本轮同步完成后结束的 Promise。
   */
  private async runSyncCycle(generation: number): Promise<boolean> {
    if (!this.httpClient || !this.config || this.stopped || generation !== this.sessionGeneration) {
      return false
    }

    const isForcePush = this.pendingForcePush
    this.pendingForcePush = false
    const hasPendingLocalChanges = this.getPendingDocumentCount(this.config) > 0
    this.setState('connecting')

    // 若本机无新增待推更改且缓存过清单 ETag，可通过一次 304 请求完成快速检查以节省坚果云限额。
    const useConditionalCheck =
      !isForcePush && !hasPendingLocalChanges && Boolean(this.cachedManifestEtag)
    const manifestResp = await this.httpClient.getJson<WebdavSyncManifest>(
      MANIFEST_REL_PATH,
      useConditionalCheck ? this.cachedManifestEtag : undefined
    )
    if (this.stopped || generation !== this.sessionGeneration) return false

    if (manifestResp.notModified) {
      return true
    }

    const manifestEtag = manifestResp.etag
    const remoteManifest: WebdavSyncManifest =
      manifestResp.notFound || !manifestResp.data
        ? this.createEmptyManifest()
        : this.normalizeManifest(manifestResp.data)

    // 第一阶段：拉取远端更新的文档和附件到本地 LMDB。
    if (!manifestResp.notFound) {
      this.setState('pulling')
      await this.pullRemoteDiffs(remoteManifest, generation)
    }

    if (this.stopped || generation !== this.sessionGeneration) return false

    // 第二阶段：检查并推送本地相对远端新增或修改的文档及附件。
    const localStateBeforePush = this.collectLocalSyncSnapshot()
    const currentLastSeq = this.db.getLastSeq()

    const docsToPush = this.computeDocsToPush(localStateBeforePush, remoteManifest, isForcePush)

    if (docsToPush.length > 0 || manifestResp.notFound) {
      this.setState('pushing')
      await this.pushLocalChanges(docsToPush, remoteManifest, manifestEtag, generation)
    } else if (manifestResp.etag) {
      this.cachedManifestEtag = manifestResp.etag
    }

    if (this.stopped || generation !== this.sessionGeneration) return false

    // 所有待同步项均已对齐，推进本地推进游标和基线。
    if (currentLastSeq > this.checkpoint.localPushSeq) {
      this.checkpoint = {
        ...this.checkpoint,
        localPushSeq: currentLastSeq
      }
      this.checkpointStore.save(this.checkpoint)
    }

    // 对所有当前一致的远端状态记录基线，供下一轮判断本地与远端谁被修改。
    const latestSnapshot = this.collectLocalSyncSnapshot()
    for (const [docId, entry] of latestSnapshot.entries()) {
      this.baselineDocs[docId] = entry.rev
    }
    this.saveBaselineDocs()
    return true
  }

  /**
   * 对比远端清单与本地基线，仅下载版本不一致且需要拉取的文档与缺失附件。
   * @param remoteManifest 远端下载的完整索引清单。
   * @param generation 发起本轮同步时的会话代数，用于在停用或重启后中止。
   * @returns 拉取阶段完成后结束的 Promise。
   */
  private async pullRemoteDiffs(
    remoteManifest: WebdavSyncManifest,
    generation: number
  ): Promise<void> {
    if (!this.httpClient || this.stopped || generation !== this.sessionGeneration) return
    const pulledDocs: DbDoc[] = []

    for (const [docId, remoteEntry] of Object.entries(remoteManifest.docs)) {
      if (this.stopped || generation !== this.sessionGeneration) return
      if (!isAccountSyncDoc(docId)) continue
      const localMeta = this.db.getSyncMeta(docId)
      const localWinningRev = localMeta?._winningRev || localMeta?._rev
      const baselineRev = this.baselineDocs[docId]

      // 本地已经拥有与远端相同的 winningRev，无需重复请求远端文档内容。
      if (localWinningRev && localWinningRev === remoteEntry.rev) {
        this.baselineDocs[docId] = remoteEntry.rev
        continue
      }

      // 若远端与基线一致但本地已自行修改为新 rev，则保留本地新版本留待推送，不误覆盖。
      if (baselineRev && remoteEntry.rev === baselineRev && localWinningRev !== baselineRev) {
        continue
      }

      if (remoteEntry.deleted) {
        const res = this.db.applyRemoteChange({
          docId,
          rev: remoteEntry.rev,
          parentRev: remoteEntry.parentRev || null,
          revisionHistory: remoteEntry.revisionHistory,
          deleted: true,
          timestamp: remoteEntry.timestamp,
          doc: null
        })
        if (res?.ok !== false) {
          this.baselineDocs[docId] = remoteEntry.rev
        }
        continue
      }

      const docResp = await this.httpClient.getJson<StoredDocPayload>(remoteEntry.docPath)
      if (this.stopped || generation !== this.sessionGeneration) return
      if (docResp.notFound || !docResp.data) continue

      const payload = docResp.data
      if (payload.doc?._attachments && typeof payload.doc._attachments === 'object') {
        await this.ensureLocalAttachments(docId, payload.doc._attachments, remoteManifest)
        if (this.stopped || generation !== this.sessionGeneration) return
      }

      const appliedRev = payload._rev || remoteEntry.rev
      const res = this.db.applyRemoteChange({
        docId,
        rev: appliedRev,
        parentRev: payload._parentRev || remoteEntry.parentRev || null,
        revisionHistory: payload._revisionHistory || remoteEntry.revisionHistory,
        deleted: Boolean(payload._deleted),
        timestamp: payload._lastModified || remoteEntry.timestamp,
        doc: payload.doc
      })
      if (res?.ok !== false) {
        this.baselineDocs[docId] = remoteEntry.rev
        if (payload.doc && res?.rev === appliedRev) {
          pulledDocs.push(payload.doc)
        }
      }
    }

    if (remoteManifest.serverSeq > this.checkpoint.remotePullSeq) {
      this.checkpoint = this.checkpointStore.commitPull(this.checkpoint, remoteManifest.serverSeq)
    }

    if (pulledDocs.length > 0) {
      this.emit('pull', pulledDocs)
    }
  }

  /**
   * 计算本次需要上传到 WebDAV 的本地文档及删除记录列表。
   * @param localSnapshot 本地作用域完整文档及删除状态快照。
   * @param remoteManifest 远端最新清单。
   * @param forcePush 是否强制覆盖推送本地全量文档。
   * @returns 待推送变更列表。
   */
  private computeDocsToPush(
    localSnapshot: Map<
      string,
      { rev: string; deleted: boolean; timestamp: number; doc: DbDoc | null }
    >,
    remoteManifest: WebdavSyncManifest,
    forcePush: boolean
  ): FullChangeEntry[] {
    const changes: FullChangeEntry[] = []

    for (const [docId, local] of localSnapshot.entries()) {
      const remote = remoteManifest.docs[docId]
      if (!forcePush && remote && remote.rev === local.rev && remote.deleted === local.deleted) {
        continue
      }
      // 跳过仅因远端版本更先获胜而不需要重复传回旧内容的情况（强推时除外）。
      const baselineRev = this.baselineDocs[docId]
      if (
        !forcePush &&
        remote &&
        baselineRev &&
        local.rev === baselineRev &&
        remote.rev !== baselineRev
      ) {
        continue
      }

      changes.push({
        seq: 0,
        docId,
        rev: local.rev,
        deleted: local.deleted,
        timestamp: local.timestamp,
        doc: local.doc,
        revisionHistory: this.db.getRevisionHistory(docId, local.rev)
      })
    }

    return changes
  }

  /**
   * 批量上传变更文档和关联附件，并以 ETag 乐观锁更新远端 `manifest.json`（遭遇 412 自动重拉合并一次）。
   * @param docsToPush 本轮待推送的变更列表。
   * @param currentManifest 当前已知远端清单。
   * @param currentEtag 当前远端清单 ETag。
   * @returns 清单写入完成后结束的 Promise。
   */
  private async pushLocalChanges(
    docsToPush: FullChangeEntry[],
    currentManifest: WebdavSyncManifest,
    currentEtag: string | undefined,
    generation: number
  ): Promise<void> {
    if (!this.httpClient || this.stopped || generation !== this.sessionGeneration) return

    let manifest = this.cloneManifest(currentManifest)
    let etag = currentEtag

    for (const change of docsToPush) {
      if (this.stopped || generation !== this.sessionGeneration) return

      // 若文档携带新附件，先把尚未存在于清单中的附件二进制文件上传到 blobs/。
      if (!change.deleted && change.doc?._attachments) {
        await this.uploadMissingAttachments(change.docId, change.doc._attachments, manifest)
      }

      const docPath = this.buildDocRelativePath(change.docId)
      const docPayload: StoredDocPayload = {
        _id: change.docId,
        _rev: change.rev,
        _parentRev: change.parentRev ?? null,
        _revisionHistory: change.revisionHistory,
        _deleted: change.deleted,
        _lastModified: change.timestamp,
        doc: change.deleted ? null : change.doc
      }

      if (change.deleted) {
        await this.httpClient.deleteFile(docPath).catch(() => undefined)
      } else {
        await this.httpClient.putJson(docPath, docPayload)
      }
      if (this.stopped || generation !== this.sessionGeneration) return

      manifest.docs[change.docId] = {
        rev: change.rev,
        parentRev: change.parentRev ?? null,
        revisionHistory: change.revisionHistory,
        deleted: change.deleted,
        timestamp: change.timestamp,
        docHash: this.hashJson(docPayload),
        docPath
      }
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      manifest.serverSeq += 1
      manifest.updatedAt = Date.now()

      try {
        if (this.stopped || generation !== this.sessionGeneration) return
        const writeResult = await this.httpClient.putJson(MANIFEST_REL_PATH, manifest, etag)
        this.cachedManifestEtag = writeResult.etag
        return
      } catch (error) {
        // 遇到 412 并发写入冲突时，拉取对方刚写入的清单并保留本机修改重合并。
        if (error instanceof WebdavHttpError && error.status === 412 && attempt === 0) {
          const refreshed = await this.httpClient.getJson<WebdavSyncManifest>(MANIFEST_REL_PATH)
          if (this.stopped || generation !== this.sessionGeneration) return
          if (!refreshed.notFound && refreshed.data) {
            const serverManifest = this.normalizeManifest(refreshed.data)
            const pushedIds = new Set(docsToPush.map((c) => c.docId))
            const merged = this.cloneManifest(serverManifest)
            for (const id of pushedIds) {
              if (manifest.docs[id]) merged.docs[id] = manifest.docs[id]
            }
            Object.assign(merged.blobs, manifest.blobs)
            manifest = merged
            etag = refreshed.etag
            continue
          }
        }
        throw error
      }
    }
  }

  private async ensureLocalAttachments(
    docId: string,
    attachments: Record<string, any>,
    manifest: WebdavSyncManifest
  ): Promise<void> {
    if (!this.httpClient) return
    for (const meta of Object.values(attachments)) {
      const digest = this.normalizeDigest(meta?.digest || '')
      if (!digest) continue
      if (this.hasLocalAttachmentBlob(docId, digest)) continue

      const blobInfo = manifest.blobs[digest]
      const blobPath = blobInfo?.blobPath || this.buildBlobRelativePath(digest)
      const fetched = await this.httpClient.getBinary(blobPath)
      if (!fetched.notFound && fetched.data) {
        this.db.putAttachmentFromRemote(
          docId,
          fetched.data,
          blobInfo?.contentType ||
            meta?.content_type ||
            fetched.contentType ||
            'application/octet-stream'
        )
      }
    }
  }

  private async uploadMissingAttachments(
    docId: string,
    attachments: Record<string, any>,
    manifest: WebdavSyncManifest
  ): Promise<void> {
    if (!this.httpClient) return
    for (const meta of Object.values(attachments)) {
      const digest = this.normalizeDigest(meta?.digest || '')
      if (!digest || manifest.blobs[digest]) continue

      const localData = this.db.getAttachment(docId)
      if (!localData) continue

      const localMeta = this.db.getAttachmentType(docId)
      const localDigest = this.normalizeDigest(localMeta?.digest || localMeta?.md5 || '')
      if (localDigest && localDigest !== digest) continue

      const blobPath = this.buildBlobRelativePath(digest)
      const contentType =
        meta?.content_type || meta?.contentType || localMeta?.type || 'application/octet-stream'
      await this.httpClient.putBuffer(blobPath, localData, contentType)

      const entry: WebdavBlobManifestEntry = {
        digest,
        contentType,
        length: localData.byteLength,
        blobPath
      }
      manifest.blobs[digest] = entry
    }
  }

  private hasLocalAttachmentBlob(docId: string, digest: string): boolean {
    const data = this.db.getAttachment(docId)
    if (!data) return false
    const meta = this.db.getAttachmentType(docId)
    if (!meta) return false
    return this.normalizeDigest(meta.digest || meta.md5 || '') === digest
  }

  private collectLocalSyncSnapshot(): Map<
    string,
    { rev: string; deleted: boolean; timestamp: number; doc: DbDoc | null }
  > {
    const result = new Map<
      string,
      { rev: string; deleted: boolean; timestamp: number; doc: DbDoc | null }
    >()

    for (const prefix of ACCOUNT_SYNC_PREFIXES) {
      for (const doc of this.db.allDocs(prefix)) {
        const meta = this.db.getSyncMeta(doc._id)
        const rev = meta?._winningRev || doc._rev || meta?._rev || '1-local'
        result.set(doc._id, {
          rev,
          deleted: false,
          timestamp: meta?._lastModified || Date.now(),
          doc
        })
      }
    }

    // 补充近期已删除的文档墓碑，确保删档也能同步到 WebDAV 清单中。
    for (const change of this.db.getChangesSince(this.checkpoint.localPushSeq)) {
      if (!isAccountSyncDoc(change.docId) || result.has(change.docId)) continue
      if (change.deleted) {
        result.set(change.docId, {
          rev: change.rev,
          deleted: true,
          timestamp: change.timestamp || Date.now(),
          doc: null
        })
      }
    }
    return result
  }

  private createEmptyManifest(): WebdavSyncManifest {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      syncEpoch: Date.now(),
      serverSeq: 0,
      updatedAt: 0,
      docs: {},
      blobs: {}
    }
  }

  private normalizeManifest(input: Partial<WebdavSyncManifest>): WebdavSyncManifest {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      syncEpoch: typeof input.syncEpoch === 'number' ? input.syncEpoch : Date.now(),
      serverSeq: typeof input.serverSeq === 'number' ? input.serverSeq : 0,
      updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : 0,
      docs: input.docs && typeof input.docs === 'object' ? { ...input.docs } : {},
      blobs: input.blobs && typeof input.blobs === 'object' ? { ...input.blobs } : {}
    }
  }

  private cloneManifest(manifest: WebdavSyncManifest): WebdavSyncManifest {
    return {
      ...manifest,
      docs: { ...manifest.docs },
      blobs: { ...manifest.blobs }
    }
  }

  /**
   * 将 docId 映射为保留层级 `/` 的安全相对路径，同时规避 Windows/坚果云禁用的特殊字符（如 `:`）。
   * @param docId LMDB 文档 ID。
   * @returns 形如 `docs/PLUGIN/foo/bar.json` 的相对路径。
   */
  private buildDocRelativePath(docId: string): string {
    const encodedSegments = docId
      .split('/')
      .filter(Boolean)
      .map((seg) => this.sanitizeSegment(seg))
    return `docs/${encodedSegments.join('/')}.json`
  }

  private buildBlobRelativePath(digest: string): string {
    return `blobs/${this.sanitizeSegment(digest)}`
  }

  private resolveScopeUrl(config?: SyncConfig | null): string | undefined {
    if (!config?.serverUrl) return undefined
    try {
      const normalizedUrl = normalizeWebdavServerUrl(config.serverUrl)
      const normalizedDir = normalizeWebdavRemoteDir(config.remoteDir)
      return `webdav:${normalizedUrl}/${normalizedDir}`
    } catch {
      return `webdav:${config.serverUrl.trim().replace(/\/+$/, '')}/${config.remoteDir || 'ZTools'}`
    }
  }

  private sanitizeSegment(segment: string): string {
    if (segment === '.' || segment === '..') {
      return `_${crypto.createHash('sha1').update(segment).digest('hex').slice(0, 12)}`
    }
    let sanitized = ''
    for (const ch of segment) {
      const code = ch.charCodeAt(0)
      if (code < 32 || '<>:"\\|?*'.includes(ch)) {
        sanitized += `_x${code.toString(16).padStart(2, '0')}`
      } else {
        sanitized += ch
      }
    }
    return sanitized
  }

  private normalizeDigest(digest: string): string {
    const trimmed = digest.trim()
    if (!trimmed) return ''
    return trimmed.startsWith('md5-') ? trimmed : `md5-${trimmed}`
  }

  private hashJson(payload: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
  }

  private getBaselineStorageKey(scopeUrl?: string, uid?: string, deviceId?: string): string {
    const rawScope =
      scopeUrl || this.httpClient?.getCheckpointScopeUrl() || this.checkpoint.serverUrl || 'webdav'
    const encoded = Buffer.from(
      `${rawScope}|${uid || this.config?.username || ''}|${deviceId || this.config?.deviceId || ''}`,
      'utf8'
    ).toString('base64url')
    return `_webdav_baseline:${encoded}`
  }

  private loadBaselineDocs(): void {
    try {
      const raw = this.db.getMetaDb().get(this.getBaselineStorageKey())
      this.baselineDocs = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    } catch {
      this.baselineDocs = {}
    }
  }

  private saveBaselineDocs(scopeUrl?: string, uid?: string, deviceId?: string): void {
    try {
      this.db
        .getMetaDb()
        .putSync(
          this.getBaselineStorageKey(scopeUrl, uid, deviceId),
          JSON.stringify(this.baselineDocs)
        )
    } catch (error) {
      console.error('[WebDAV] 保存远端文档基线失败:', error)
    }
  }
}
