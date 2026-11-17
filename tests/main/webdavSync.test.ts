import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { StorageManager } from '../../src/main/core/storage/storageManager'
import { WebdavHttpClient, WebdavHttpError } from '../../src/main/core/sync/webdavHttpClient'
import { WebDAVSyncClient } from '../../src/main/core/sync/webdavSyncClient'
import {
  DEFAULT_WEBDAV_REMOTE_DIR,
  normalizeWebdavRemoteDir,
  normalizeWebdavServerUrl
} from '../../src/shared/syncServerUrl'

interface MockWebdavServerHandle {
  baseUrl: string
  files: Map<string, { body: Buffer; contentType: string; etag: string }>
  dirs: Set<string>
  requests: Array<{ method: string; path: string; ifNoneMatch?: string }>
  close: () => Promise<void>
}

const tempRoots: string[] = []
const activeServers: MockWebdavServerHandle[] = []

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-webdav-test-'))
  tempRoots.push(root)
  return root
}

/**
 * 启动一个挂载在 `/dav/` 子路径下的内存 WebDAV HTTP 测试服务器，模拟坚果云鉴权、MKCOL、PROPFIND 与 ETag。
 * @param options 账号密码及可选故障注入控制。
 * @returns 已启动的测试服务器句柄。
 */
async function startMockWebdavServer(options?: {
  username?: string
  password?: string
  failOnce503OnPut?: boolean
}): Promise<MockWebdavServerHandle> {
  const expectedUser = options?.username ?? 'flycodeu@zohomail.cn'
  const expectedPass = options?.password ?? 'app-secret-123'
  const expectedAuth = `Basic ${Buffer.from(`${expectedUser}:${expectedPass}`, 'utf8').toString('base64')}`

  const files = new Map<string, { body: Buffer; contentType: string; etag: string }>()
  const dirs = new Set<string>(['/dav'])
  const requests: Array<{ method: string; path: string; ifNoneMatch?: string }> = []
  let etagCounter = 1
  let pending503 = Boolean(options?.failOnce503OnPut)

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
    const decodedPath = decodeURIComponent(reqUrl.pathname).replace(/\/+$/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()
    requests.push({
      method,
      path: decodedPath,
      ifNoneMatch:
        typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined
    })

    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MockWebDAV"' })
      res.end('Unauthorized')
      return
    }

    if (!decodedPath.startsWith('/dav')) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    if (method === 'PROPFIND') {
      await readBody(req)
      if (!dirs.has(decodedPath) && !files.has(decodedPath)) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      res.end(
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${reqUrl.pathname}</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
      )
      return
    }

    if (method === 'MKCOL') {
      await readBody(req)
      if (dirs.has(decodedPath)) {
        res.writeHead(405)
        res.end('Already exists')
        return
      }
      const parent = decodedPath.slice(0, decodedPath.lastIndexOf('/')) || '/'
      if (!dirs.has(parent)) {
        res.writeHead(409)
        res.end('Parent missing')
        return
      }
      dirs.add(decodedPath)
      res.writeHead(201)
      res.end('Created')
      return
    }

    if (method === 'PUT') {
      const body = await readBody(req)
      if (pending503) {
        pending503 = false
        res.writeHead(503, { 'Retry-After': '0' })
        res.end('Service Unavailable')
        return
      }
      const parent = decodedPath.slice(0, decodedPath.lastIndexOf('/')) || '/'
      if (!dirs.has(parent)) {
        res.writeHead(409)
        res.end('Parent directory missing')
        return
      }
      const existing = files.get(decodedPath)
      const ifMatch = req.headers['if-match']
      if (ifMatch && existing && existing.etag !== ifMatch) {
        res.writeHead(412)
        res.end('Precondition Failed')
        return
      }
      const nextEtag = `"etag-${etagCounter++}"`
      files.set(decodedPath, {
        body,
        contentType: String(req.headers['content-type'] || 'application/octet-stream'),
        etag: nextEtag
      })
      res.writeHead(existing ? 204 : 201, { ETag: nextEtag })
      res.end()
      return
    }

    if (method === 'GET') {
      const entry = files.get(decodedPath)
      if (!entry) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      if (req.headers['if-none-match'] === entry.etag) {
        res.writeHead(304, { ETag: entry.etag })
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': entry.contentType,
        ETag: entry.etag
      })
      res.end(entry.body)
      return
    }

    if (method === 'DELETE') {
      files.delete(decodedPath)
      res.writeHead(204)
      res.end()
      return
    }

    res.writeHead(405)
    res.end('Method Not Allowed')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const handle: MockWebdavServerHandle = {
    baseUrl: `http://127.0.0.1:${address.port}/dav/`,
    files,
    dirs,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
  activeServers.push(handle)
  return handle
}

async function waitForSyncLive(client: WebDAVSyncClient, action?: () => void): Promise<void> {
  let listenerRegistered = false
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`等待 WebDAV 同步进入 live 超时，当前状态: ${client.getState()}`))
    }, 5000)
    const onState = (state: string): void => {
      if (state === 'live') {
        cleanup()
        resolve()
      }
    }
    const onErr = (msg: string): void => {
      cleanup()
      reject(new Error(`WebDAV 同步报错: ${msg}`))
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      client.removeListener('state', onState)
      client.removeListener('sync-error', onErr)
    }
    client.on('state', onState)
    client.on('sync-error', onErr)
    listenerRegistered = true
    if (action) {
      action()
    } else if (client.getState() === 'live') {
      cleanup()
      resolve()
    }
  })
  void listenerRegistered
}

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()!.close()
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('WebDAV 同步地址校验、HTTP 客户端与双端同步', () => {
  it('normalizeWebdavServerUrl 与 normalizeWebdavRemoteDir 应完整保留子路径并拦截非法格式', () => {
    expect(normalizeWebdavServerUrl(' https://dav.jianguoyun.com/dav/ ')).toBe(
      'https://dav.jianguoyun.com/dav'
    )
    expect(normalizeWebdavServerUrl('http://nas.local:5005/webdav/sub///')).toBe(
      'http://nas.local:5005/webdav/sub'
    )
    expect(() => normalizeWebdavServerUrl('')).toThrow('请填写 WebDAV 服务器地址')
    expect(() => normalizeWebdavServerUrl('wss://dav.jianguoyun.com/dav')).toThrow(
      '仅支持 http 或 https'
    )
    expect(() => normalizeWebdavServerUrl('https://user:pass@dav.jianguoyun.com/dav')).toThrow(
      '请勿在服务器地址中包含账号或密码'
    )

    expect(normalizeWebdavRemoteDir(undefined)).toBe(DEFAULT_WEBDAV_REMOTE_DIR)
    expect(normalizeWebdavRemoteDir('/Apps/ZTools/')).toBe('Apps/ZTools')
    expect(() => normalizeWebdavRemoteDir('../escape')).toThrow('非法路径段')
  })

  it('WebdavHttpClient 应支持 /dav/ 子路径鉴权、递归 MKCOL、503 重试与 ETag 条件请求', async () => {
    const server = await startMockWebdavServer({ failOnce503OnPut: true })
    const client = new WebdavHttpClient({
      serverUrl: server.baseUrl,
      remoteDir: 'Apps/ZTools',
      username: 'flycodeu@zohomail.cn',
      password: 'app-secret-123'
    })

    expect(await client.testConnection()).toBe(true)
    expect(server.dirs.has('/dav/Apps')).toBe(true)
    expect(server.dirs.has('/dav/Apps/ZTools')).toBe(true)

    // 首次 PUT 触发一次 503，客户端应自动退避重试并写入成功。
    const putRes = await client.putJson('docs/ZTOOLS/demo.json', { hello: 'webdav' })
    expect(putRes.etag).toBeTruthy()
    expect(server.files.has('/dav/Apps/ZTools/docs/ZTOOLS/demo.json')).toBe(true)

    // 携带匹配 ETag 时直接命中 304 Not Modified。
    const notModified = await client.getJson('docs/ZTOOLS/demo.json', putRes.etag)
    expect(notModified.notModified).toBe(true)

    // 错误密码应抛出明确认证失败异常。
    const badAuth = new WebdavHttpClient({
      serverUrl: server.baseUrl,
      username: 'flycodeu@zohomail.cn',
      password: 'wrong'
    })
    await expect(badAuth.testConnection()).rejects.toThrow(WebdavHttpError)
  })

  it('双设备 WebDAVSyncClient 应基于真实 LMDB 完成文档、附件与删除双向同步，空闲轮询命中 304', async () => {
    const server = await startMockWebdavServer()
    const managerA = new StorageManager({ homeDir: makeTempRoot(), mapSize: 64 * 1024 * 1024 })
    const managerB = new StorageManager({ homeDir: makeTempRoot(), mapSize: 64 * 1024 * 1024 })

    const dbA = managerA.getAccountDb()
    const dbB = managerB.getAccountDb()
    const clientA = new WebDAVSyncClient(dbA)
    const clientB = new WebDAVSyncClient(dbB)

    try {
      dbA.put({ _id: 'ZTOOLS/user-settings', data: { theme: 'dark', syncVia: 'webdav' } })
      dbA.put({ _id: 'PLUGIN/demo-plugin/config', data: { count: 42 } })
      dbA.postAttachment('ZTOOLS/avatar', Buffer.from('mock-avatar-png-bytes'), 'image/png')

      const configA = {
        provider: 'webdav' as const,
        enabled: true,
        serverUrl: server.baseUrl,
        remoteDir: 'ZTools',
        token: '',
        syncInterval: 60,
        lastSyncTime: 0,
        deviceId: 'device-a',
        username: 'flycodeu@zohomail.cn',
        password: 'app-secret-123'
      }

      await waitForSyncLive(clientA, () => clientA.start(configA))

      expect(server.files.has('/dav/ZTools/manifest.json')).toBe(true)
      expect(server.files.has('/dav/ZTools/docs/ZTOOLS/user-settings.json')).toBe(true)
      expect(server.files.has('/dav/ZTools/docs/PLUGIN/demo-plugin/config.json')).toBe(true)

      // 再次触发同步且无本地新变更时，应命中 304 Not Modified 且不重复上传。
      const reqCountBefore = server.requests.length
      await waitForSyncLive(clientA, () => clientA.start(configA))
      const putsInSecondRun = server.requests
        .slice(reqCountBefore)
        .filter((r) => r.method === 'PUT')
      expect(putsInSecondRun).toHaveLength(0)

      // 设备 B 连接同一坚果云子路径，应拉取所有文档与二进制附件。
      const configB = { ...configA, deviceId: 'device-b' }
      await waitForSyncLive(clientB, () => clientB.start(configB))

      expect(dbB.get('ZTOOLS/user-settings')?.data).toEqual({ theme: 'dark', syncVia: 'webdav' })
      expect(dbB.get('PLUGIN/demo-plugin/config')?.data).toEqual({ count: 42 })
      expect(Buffer.from(dbB.getAttachment('ZTOOLS/avatar') || []).toString('utf8')).toBe(
        'mock-avatar-png-bytes'
      )

      // 设备 B 删除插件文档后推送，设备 A 重新同步应同步删除。
      dbB.remove('PLUGIN/demo-plugin/config')
      await waitForSyncLive(clientB, () => clientB.performSync())

      await waitForSyncLive(clientA, () => clientA.performSync())
      expect(dbA.get('PLUGIN/demo-plugin/config')).toBeNull()
    } finally {
      clientA.stop()
      clientB.stop()
      managerA.close()
      managerB.close()
    }
  })
})
