import { normalizeWebdavRemoteDir, normalizeWebdavServerUrl } from '../../../shared/syncServerUrl'

export interface WebdavClientOptions {
  serverUrl: string
  remoteDir?: string
  username: string
  password: string
  requestTimeoutMs?: number
}

export interface WebdavJsonFetchResult<T> {
  notFound: boolean
  notModified: boolean
  etag?: string
  data?: T
}

export interface WebdavBinaryFetchResult {
  notFound: boolean
  data?: Buffer
  contentType?: string
  etag?: string
}

const DEFAULT_TIMEOUT_MS = 20_000
const PROPFIND_MINIMAL_BODY =
  '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'

/**
 * 封装 WebDAV 请求过程中产生的 HTTP 协议或认证错误。
 */
export class WebdavHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'WebdavHttpError'
  }
}

/**
 * 基于 Node 内置 fetch 实现的零依赖 WebDAV HTTP 客户端，兼容坚果云子路径、目录分级与限流退避。
 */
export class WebdavHttpClient {
  public readonly serverUrl: string
  public readonly remoteDir: string
  private readonly authHeader: string
  private readonly requestTimeoutMs: number
  private readonly confirmedDirs = new Set<string>()

  /**
   * 构造并校验 WebDAV 客户端实例。
   * @param options 服务地址（可含 `/dav/` 等子路径）、同步子目录与 Basic 认证凭据。
   * @returns 初始化完成的客户端实例。
   * @throws 当服务器地址、远端目录或用户名/密码缺失或非法时抛出错误。
   */
  constructor(options: WebdavClientOptions) {
    this.serverUrl = normalizeWebdavServerUrl(options.serverUrl)
    this.remoteDir = normalizeWebdavRemoteDir(options.remoteDir)
    const username = options.username.trim()
    if (!username || !options.password) {
      throw new Error('请填写完整的 WebDAV 用户名和应用密码')
    }
    this.authHeader = `Basic ${Buffer.from(`${username}:${options.password}`, 'utf8').toString('base64')}`
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 构造当前 WebDAV 目标路径的稳定作用域标识，供多端同步 checkpoint 隔离使用。
   * @returns 以 `webdav:` 为前缀的唯一标识字符串。
   */
  public getCheckpointScopeUrl(): string {
    return `webdav:${this.serverUrl}/${this.remoteDir}`
  }

  /**
   * 校验当前服务器连通性、Basic 认证及远端同步目录写前准备情况。
   * @returns 连接成功时返回 true。
   * @throws 当认证失败、地址不支持 WebDAV 或网络超时时抛出中文可展示错误。
   */
  public async testConnection(): Promise<boolean> {
    this.confirmedDirs.clear()

    // 先验证基础入口的 WebDAV 能力与账号认证，避免直接 MKCOL 被掩盖为权限问题。
    const probeResp = await this.requestWithRetry(
      this.buildUrl('', false, true),
      {
        method: 'PROPFIND',
        headers: {
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8'
        },
        body: PROPFIND_MINIMAL_BODY
      },
      [200, 207]
    )

    // 少数 WebDAV 服务（部分 NAS/反向代理）不支持 Depth: 0 时回退用 Depth: 1 验证目录列表。
    if (!probeResp.ok) {
      const fallbackResp = await this.requestWithRetry(
        this.buildUrl('', false, true),
        {
          method: 'PROPFIND',
          headers: {
            Depth: '1',
            'Content-Type': 'application/xml; charset=utf-8'
          },
          body: PROPFIND_MINIMAL_BODY
        },
        [200, 207]
      )
      if (!fallbackResp.ok) {
        this.throwForHttpStatus(fallbackResp.status, fallbackResp.headers.get('retry-after'))
      }
    }

    // 确认或创建远端同步根目录（如 /dav/ZTools/），确保后续同步具备目录结构。
    await this.ensureDirectory('')
    return true
  }

  /**
   * 递归确保目标相对子目录（相对于 remoteDir）在 WebDAV 服务端存在。
   * @param relativeDir 相对 `remoteDir` 的目录路径；为空字符串时表示 `remoteDir` 本身。
   * @returns 目录确认或创建完成后结束的 Promise。
   */
  public async ensureDirectory(relativeDir: string): Promise<void> {
    const baseSegments = this.remoteDir ? this.remoteDir.split('/').filter(Boolean) : []
    const extraSegments = relativeDir.replace(/\\+/g, '/').split('/').filter(Boolean)
    const allSegments = [...baseSegments, ...extraSegments]
    if (allSegments.length === 0) return

    let currentPath = ''
    for (const seg of allSegments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg
      if (this.confirmedDirs.has(currentPath)) continue

      await this.createSingleDirectoryAbsolute(currentPath)
      this.confirmedDirs.add(currentPath)
    }
  }

  /**
   * 从 WebDAV 服务端读取 JSON 文件，支持 `If-None-Match` 条件请求节省坚果云流量与配额。
   * @param relativePath 相对于 `remoteDir` 的文件路径。
   * @param ifNoneMatch 可选上次缓存的 ETag，匹配时直接返回 `notModified: true`。
   * @returns 解析后的 JSON 载荷与最新 ETag，不存在时返回 `notFound: true`。
   */
  public async getJson<T>(
    relativePath: string,
    ifNoneMatch?: string
  ): Promise<WebdavJsonFetchResult<T>> {
    const headers: Record<string, string> = {}
    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch
    }

    const resp = await this.requestWithRetry(
      this.buildUrl(relativePath, true, false),
      { method: 'GET', headers },
      [200, 206, 304, 404]
    )

    const etag = this.cleanEtag(resp.headers.get('etag'))
    if (resp.status === 304) {
      return { notFound: false, notModified: true, etag: etag || ifNoneMatch }
    }
    if (resp.status === 404) {
      return { notFound: true, notModified: false }
    }
    if (!resp.ok) {
      this.throwForHttpStatus(resp.status, resp.headers.get('retry-after'))
    }

    const text = await resp.text()
    try {
      return {
        notFound: false,
        notModified: false,
        etag,
        data: JSON.parse(text) as T
      }
    } catch {
      throw new Error(`WebDAV 文件格式无效，无法解析 JSON: ${relativePath}`)
    }
  }

  /**
   * 读取 WebDAV 服务端二进制附件内容。
   * @param relativePath 相对于 `remoteDir` 的附件路径。
   * @returns 附件二进制 Buffer 及 MIME 类型，不存在时返回 `notFound: true`。
   */
  public async getBinary(relativePath: string): Promise<WebdavBinaryFetchResult> {
    const resp = await this.requestWithRetry(
      this.buildUrl(relativePath, true, false),
      { method: 'GET' },
      [200, 206, 404]
    )

    if (resp.status === 404) {
      return { notFound: true }
    }
    if (!resp.ok) {
      this.throwForHttpStatus(resp.status, resp.headers.get('retry-after'))
    }

    const arrayBuffer = await resp.arrayBuffer()
    return {
      notFound: false,
      data: Buffer.from(arrayBuffer),
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
      etag: this.cleanEtag(resp.headers.get('etag'))
    }
  }

  /**
   * 上传 JSON 文件到 WebDAV，自动补齐分层父目录并支持 ETag 并发防覆盖校验。
   * @param relativePath 相对于 `remoteDir` 的目标路径。
   * @param payload 可序列化的 JSON 数据对象。
   * @param ifMatch 可选预期 ETag，服务端返回 412 时由调用方感知并发写入冲突。
   * @returns 上传成功后服务端返回的最新 ETag。
   */
  public async putJson(
    relativePath: string,
    payload: unknown,
    ifMatch?: string
  ): Promise<{ etag?: string }> {
    const body = JSON.stringify(payload)
    return this.putBuffer(
      relativePath,
      Buffer.from(body, 'utf8'),
      'application/json; charset=utf-8',
      ifMatch
    )
  }

  /**
   * 上传二进制或文本内容到 WebDAV 指定相对路径。
   * @param relativePath 相对于 `remoteDir` 的目标路径。
   * @param data 待上传二进制数据。
   * @param contentType HTTP Content-Type 头部。
   * @param ifMatch 可选并发控制 `If-Match` 头。
   * @returns 写入后的响应 ETag。
   */
  public async putBuffer(
    relativePath: string,
    data: Buffer | Uint8Array,
    contentType = 'application/octet-stream',
    ifMatch?: string
  ): Promise<{ etag?: string }> {
    const parentDir = this.parentDirOf(relativePath)
    await this.ensureDirectory(parentDir)

    const headers: Record<string, string> = {
      'Content-Type': contentType
    }
    if (ifMatch) {
      headers['If-Match'] = ifMatch
    }

    const resp = await this.requestWithRetry(
      this.buildUrl(relativePath, true, false),
      {
        method: 'PUT',
        headers,
        body: new Uint8Array(data)
      },
      [200, 201, 204]
    )

    if (!resp.ok) {
      this.throwForHttpStatus(resp.status, resp.headers.get('retry-after'))
    }

    return { etag: this.cleanEtag(resp.headers.get('etag')) }
  }

  /**
   * 删除 WebDAV 指定路径文件（已不存在时视作成功）。
   * @param relativePath 相对于 `remoteDir` 的文件路径。
   * @returns 删除完成后结束的 Promise。
   */
  public async deleteFile(relativePath: string): Promise<void> {
    const resp = await this.requestWithRetry(
      this.buildUrl(relativePath, true, false),
      { method: 'DELETE' },
      [200, 202, 204, 404]
    )
    if (!resp.ok && resp.status !== 404) {
      this.throwForHttpStatus(resp.status, resp.headers.get('retry-after'))
    }
  }

  /**
   * 按绝对子路径（相对 `serverUrl`）创建单个 WebDAV 目录，兼容 405 已存在和 409 缺失上级。
   * @param pathFromServerRoot 相对于 `serverUrl` 的多段路径。
   * @returns 目录确认存在后结束的 Promise。
   */
  private async createSingleDirectoryAbsolute(pathFromServerRoot: string): Promise<void> {
    const url = this.buildAbsoluteFromServer(pathFromServerRoot, true)
    const resp = await this.requestWithRetry(
      url,
      { method: 'MKCOL' },
      [200, 201, 204, 301, 302, 405]
    )
    if (resp.ok || resp.status === 405 || resp.status === 301 || resp.status === 302) {
      return
    }
    if (resp.status === 409) {
      // 并发或缓存过期时先核查父目录是否真实存在，若仍失败再把底层状态透出。
      const checkResp = await this.requestWithRetry(
        url,
        {
          method: 'PROPFIND',
          headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
          body: PROPFIND_MINIMAL_BODY
        },
        [200, 207]
      )
      if (checkResp.ok) return
    }
    this.throwForHttpStatus(resp.status, resp.headers.get('retry-after'))
  }

  /**
   * 构造带逐段 URL 编码的完整 WebDAV 请求地址，保留 `/` 分隔符以兼容坚果云与主流服务端。
   * @param relativePath 相对路径。
   * @param includeRemoteDir 是否拼接配置的同步子目录。
   * @param trailingSlash 目录类请求（如 PROPFIND/MKCOL）是否附加末尾斜杠。
   * @returns 可直接用于 `fetch` 的完整 URL。
   */
  private buildUrl(
    relativePath: string,
    includeRemoteDir: boolean,
    trailingSlash: boolean
  ): string {
    const prefix = includeRemoteDir && this.remoteDir ? this.remoteDir : ''
    const cleanRel = relativePath.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '')
    const combined = prefix && cleanRel ? `${prefix}/${cleanRel}` : prefix || cleanRel
    return this.buildAbsoluteFromServer(combined, trailingSlash)
  }

  private buildAbsoluteFromServer(pathFromServerRoot: string, trailingSlash: boolean): string {
    const segments = pathFromServerRoot
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
    const base = segments.length > 0 ? `${this.serverUrl}/${segments.join('/')}` : this.serverUrl
    return trailingSlash ? `${base}/` : base
  }

  private parentDirOf(relativePath: string): string {
    const clean = relativePath.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '')
    const lastSlash = clean.lastIndexOf('/')
    return lastSlash <= 0 ? '' : clean.slice(0, lastSlash)
  }

  private cleanEtag(etag: string | null): string | undefined {
    const trimmed = etag?.trim()
    return trimmed ? trimmed : undefined
  }

  /**
   * 统一发送带认证、超时与限流退避重试的 HTTP 请求。
   * @param url 请求地址。
   * @param init Fetch 请求选项。
   * @param expectedStatuses 允许的 HTTP 状态码列表（非此列表中的 429/503 将触发指数退避重试）。
   * @returns 最终的 HTTP Response 对象。
   */
  private async requestWithRetry(
    url: string,
    init: RequestInit,
    expectedStatuses: number[]
  ): Promise<Response> {
    const maxAttempts = 3
    let lastError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          Authorization: this.authHeader,
          ...((init.headers as Record<string, string>) || {})
        }
        const resp = await fetch(url, {
          ...init,
          headers,
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        })

        // 坚果云高频请求可能返回 429 或 503，按 Retry-After 或退避等待后自动重试。
        if (
          (resp.status === 429 || resp.status === 503) &&
          !expectedStatuses.includes(resp.status) &&
          attempt < maxAttempts - 1
        ) {
          const waitMs = this.parseRetryAfterMs(resp.headers.get('retry-after'), attempt)
          await this.sleep(waitMs)
          continue
        }

        return resp
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts - 1) {
          await this.sleep(300 * 2 ** attempt)
          continue
        }
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : '网络请求超时或无法连接 WebDAV 服务器'
    throw new Error(message)
  }

  private parseRetryAfterMs(retryAfter: string | null, attempt: number): number {
    const seconds = retryAfter ? Number(retryAfter) : NaN
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 5000)
    }
    return Math.min(600 * 2 ** attempt, 4000)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private throwForHttpStatus(status: number, retryAfterHeader: string | null): never {
    const retryAfterMs = retryAfterHeader ? this.parseRetryAfterMs(retryAfterHeader, 0) : undefined
    if (status === 401 || status === 403) {
      throw new WebdavHttpError(
        'WebDAV 认证失败，请检查用户名或应用密码（坚果云需在安全选项中生成第三方应用密码）',
        status,
        retryAfterMs
      )
    }
    if (status === 404) {
      throw new WebdavHttpError('WebDAV 目标路径不存在，请检查服务器地址中的子路径', status)
    }
    if (status === 405) {
      throw new WebdavHttpError('当前服务器或路径未开启 WebDAV 服务（405）', status)
    }
    if (status === 412) {
      throw new WebdavHttpError('远端清单已被其他设备更新，需要重新合并后写入', status)
    }
    if (status === 429 || status === 503) {
      throw new WebdavHttpError('WebDAV 服务器限流或暂不可用，请稍后重试', status, retryAfterMs)
    }
    throw new WebdavHttpError(`WebDAV 请求失败（HTTP ${status}）`, status, retryAfterMs)
  }
}
