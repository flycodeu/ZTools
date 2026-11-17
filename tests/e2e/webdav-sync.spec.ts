import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const settingsUrlFragments = ['http://127.0.0.1:15177', 'internal-plugins/setting/index.html']

interface MockWebdavHandle {
  serverUrl: string
  files: Map<string, { body: Buffer; contentType: string; etag: string }>
  close: () => Promise<void>
}

/**
 * 启动挂载在 `/dav/` 子路径下的本地模拟 WebDAV 服务，用于隔离端到端测试。
 * @param username 期望的认证用户名。
 * @param password 期望的应用密码。
 * @returns 已就绪的本地 WebDAV 服务地址与关闭句柄。
 */
async function startMockWebdavServer(
  username: string,
  password: string
): Promise<MockWebdavHandle> {
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
  const files = new Map<string, { body: Buffer; contentType: string; etag: string }>()
  const dirs = new Set<string>(['/dav'])
  let etagCounter = 1

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

    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401)
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
      res.end('<D:multistatus xmlns:D="DAV:"/>')
      return
    }
    if (method === 'MKCOL') {
      await readBody(req)
      if (dirs.has(decodedPath)) {
        res.writeHead(405)
        res.end('Exists')
        return
      }
      dirs.add(decodedPath)
      res.writeHead(201)
      res.end('Created')
      return
    }
    if (method === 'PUT') {
      const body = await readBody(req)
      const nextEtag = `"e2e-${etagCounter++}"`
      files.set(decodedPath, {
        body,
        contentType: String(req.headers['content-type'] || 'application/octet-stream'),
        etag: nextEtag
      })
      res.writeHead(201, { ETag: nextEtag })
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
      res.writeHead(200, { 'Content-Type': entry.contentType, ETag: entry.etag })
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
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    serverUrl: `http://127.0.0.1:${address.port}/dav/`,
    files,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

/**
 * 启动使用隔离数据目录的 ZTools Electron 测试实例。
 * @param dataRoot 测试专用数据目录。
 * @param legacyRoot 测试专用旧数据目录。
 * @returns 启动后的 Electron 应用实例。
 */
async function launchTestApp(dataRoot: string, legacyRoot: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1]))
      ),
      ZTOOLS_DATA_ROOT: dataRoot,
      ZTOOLS_E2E: '1',
      ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
      ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
    }
  })
}

/**
 * 读取设置插件 WebContentsView 的当前可见正文，用于等待界面进入稳定态。
 * @param electronApp 当前 Electron 应用实例。
 * @returns 页面可见文本；视图尚未加载时返回空字符串。
 */
async function readSettingsText(electronApp: ElectronApplication): Promise<string> {
  return await electronApp.evaluate(async ({ webContents }, urlFragments) => {
    const settingsContents = webContents
      .getAllWebContents()
      .find((contents) => urlFragments.some((fragment) => contents.getURL().includes(fragment)))
    if (!settingsContents || settingsContents.isLoading()) return ''
    return await settingsContents.executeJavaScript('document.body?.innerText || ""')
  }, settingsUrlFragments)
}

/**
 * 在设置插件 WebContentsView 中执行脚本以驱动表单交互与校验返回值。
 * @param electronApp 当前 Electron 应用实例。
 * @param source 待执行的 JavaScript 代码。
 * @returns 脚本执行返回值。
 */
async function executeInSettings(
  electronApp: ElectronApplication,
  source: string
): Promise<unknown> {
  return await electronApp.evaluate(
    async ({ webContents }, { script, urlFragments }) => {
      const settingsContents = webContents
        .getAllWebContents()
        .find((contents) => urlFragments.some((fragment) => contents.getURL().includes(fragment)))
      if (!settingsContents) throw new Error('未找到设置插件 WebContentsView')
      return await settingsContents.executeJavaScript(script)
    },
    { script: source, urlFragments: settingsUrlFragments }
  )
}

test('支持含 /dav/ 子路径的 WebDAV 模式并从私有部署报错快捷切换与同步验证', async ({
  browserName: _browserName
}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-webdav-e2e-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  const screenshotPath = testInfo.outputPath('webdav-sync-settings.png')
  const username = 'flycodeu@zohomail.cn'
  const password = 'mock-app-password'
  const webdavServer = await startMockWebdavServer(username, password)
  let electronApp: ElectronApplication | null = null

  await fs.mkdir(legacyRoot, { recursive: true })

  try {
    electronApp = await launchTestApp(dataRoot, legacyRoot)
    const mainPage = await electronApp.firstWindow()
    const searchInput = mainPage.locator('.search-input')
    await expect(searchInput).toBeVisible()

    // 导航到数据同步设置页并等待官方/私有/WebDAV 标签页渲染完成。
    await searchInput.fill('WebDAV 同步')
    const syncResult = mainPage
      .locator('.app-item, .list-item')
      .filter({ hasText: 'WebDAV 同步' })
      .first()
    await expect(syncResult).toBeVisible()
    await syncResult.click()
    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 15_000 })
      .toContain('使用 ZTools 官方同步服务')

    // 点击“私有部署”标签页并确认切换到私有部署，等待输入框正式渲染完成。
    await executeInSettings(
      electronApp,
      `document.querySelector('[data-testid="sync-mode-private"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`
    )
    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 10_000 })
      .toContain('切换同步服务')
    await executeInSettings(
      electronApp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('.dialog-overlay button')).find(
          (b) => b.textContent?.trim() === '切换到私有部署'
        )
        if (!(btn instanceof HTMLButtonElement)) throw new Error('未找到切换确认按钮')
        btn.click()
      })()`
    )
    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 10_000 })
      .toContain('登录服务器')

    // 先在“私有部署”填入带 /dav/ 子路径的地址并测试连接，触发错误后点击“改用 WebDAV 模式”。
    await executeInSettings(
      electronApp,
      `(async () => {
        const setInputValue = (el, val) => {
          el.value = val
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const privUrlInput = document.querySelector('[data-testid="private-sync-server"]')
        const privUserInput = document.querySelector('[data-testid="private-sync-username"]')
        if (!(privUrlInput instanceof HTMLInputElement) || !(privUserInput instanceof HTMLInputElement)) {
          throw new Error('未找到私有部署输入框')
        }
        setInputValue(privUrlInput, ${JSON.stringify(webdavServer.serverUrl)})
        setInputValue(privUserInput, ${JSON.stringify(username)})
        // 等待 Vue 更新 v-model 并解除“测试连接”按钮 disabled 状态。
        await new Promise((r) => setTimeout(r, 50))
        const testBtn = Array.from(document.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('测试连接')
        )
        if (!(testBtn instanceof HTMLButtonElement) || testBtn.disabled) {
          throw new Error('测试连接按钮仍处于禁用状态')
        }
        testBtn.click()
      })()`
    )
    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 10_000 })
      .toContain('服务器地址暂不支持子路径')
    await executeInSettings(
      electronApp,
      `(() => {
        const switchHintBtn = document.querySelector('.webdav-switch-hint-btn')
        if (!(switchHintBtn instanceof HTMLButtonElement)) {
          throw new Error('未显示“改用 WebDAV 模式”快捷引导按钮')
        }
        switchHintBtn.click()
      })()`
    )

    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 10_000 })
      .toContain('填入坚果云地址')

    // 在 WebDAV 模式下测试连接、保存凭据并确认返回摘要中不包含明文密码。
    await executeInSettings(
      electronApp,
      `(async () => {
        const setInputValue = (el, val) => {
          el.value = val
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const passInput = document.querySelector('[data-testid="webdav-sync-password"]')
        if (!(passInput instanceof HTMLInputElement)) throw new Error('未找到 WebDAV 密码输入框')
        setInputValue(passInput, ${JSON.stringify(password)})
        await new Promise((r) => setTimeout(r, 50))

        const testBtn = Array.from(document.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('测试连接')
        )
        if (!(testBtn instanceof HTMLButtonElement) || testBtn.disabled) {
          throw new Error('WebDAV 测试连接按钮仍处于禁用状态')
        }
        testBtn.click()
      })()`
    )
    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 10_000 })
      .toContain('连接成功')

    const statusAfterLogin = (await executeInSettings(
      electronApp,
      `(async () => {
        const loginBtn = document.querySelector('[data-testid="webdav-sync-login"]')
        if (!(loginBtn instanceof HTMLButtonElement)) throw new Error('未找到 WebDAV 登录按钮')
        loginBtn.click()

        for (let i = 0; i < 40; i += 1) {
          await new Promise((r) => setTimeout(r, 150))
          if (document.querySelector('[data-testid="webdav-sync-session"]')) break
        }
        if (!document.querySelector('[data-testid="webdav-sync-session"]')) {
          throw new Error('WebDAV 登录后未展示已连接摘要')
        }

        return await window.ztools.internal.syncGetStatus()
      })()`
    )) as any

    expect(statusAfterLogin?.status?.profile?.provider).toBe('webdav')
    expect(statusAfterLogin?.status?.webdavSession?.configured).toBe(true)
    expect(statusAfterLogin?.status?.config?.password).toBe('')

    // 开启 WebDAV 同步并写入一笔账号数据，验证能推送到 `/dav/ZTools/` 下的 manifest 与文档路径。
    await executeInSettings(
      electronApp,
      `(async () => {
        await window.ztools.internal.dbPut('user-settings', { theme: 'dark', e2e: true })
        const toggle = document.querySelector('.header-toggle input[type="checkbox"]')
        if (!(toggle instanceof HTMLInputElement)) throw new Error('未找到同步总开关')
        toggle.click()
      })()`
    )

    await expect
      .poll(() => webdavServer.files.has('/dav/ZTools/manifest.json'), { timeout: 15_000 })
      .toBe(true)

    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 10_000 })
      .toContain('实时同步中')

    // 仅截取设置插件 WebContentsView 当前可见区域，确认界面完整渲染。
    const settingsPngBase64 = await electronApp.evaluate(async ({ webContents }, urlFragments) => {
      const settingsContents = webContents
        .getAllWebContents()
        .find((contents) => urlFragments.some((fragment) => contents.getURL().includes(fragment)))
      if (!settingsContents) throw new Error('未找到设置插件 WebContentsView')
      return (await settingsContents.capturePage()).toPNG().toString('base64')
    }, settingsUrlFragments)
    const settingsPng = Buffer.from(settingsPngBase64, 'base64')
    await fs.writeFile(screenshotPath, settingsPng)
    await testInfo.attach('webdav-sync-settings', {
      body: settingsPng,
      contentType: 'image/png'
    })
  } finally {
    if (electronApp) await electronApp.close()
    await webdavServer.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
