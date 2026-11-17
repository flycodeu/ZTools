import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const settingsUrlFragments = ['http://127.0.0.1:15177', 'internal-plugins/setting/index.html']

/**
 * 使用隔离临时目录启动受测 ZTools Electron 实例。
 * @param dataRoot 测试专用数据根目录。
 * @param legacyRoot 测试专用旧数据根目录。
 * @returns 已启动的 Electron 应用实例。
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
 * 读取设置插件 WebContentsView 的正文文本，用于等待稳定内容渲染完成。
 * @param electronApp 当前隔离 Electron 应用实例。
 * @returns 设置插件当前可见正文文本。
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
 * 在设置插件 WebContentsView 内执行 JavaScript 脚本。
 * @param electronApp 当前隔离 Electron 应用实例。
 * @param source 要执行的源码文本。
 * @returns 脚本返回值。
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

test('设置页更新偏好与更新弹窗多源自由切换端到端验证', async ({
  browserName: _browserName
}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-updater-e2e-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  const aboutScreenshotPath = testInfo.outputPath('about-update-options.png')
  const updaterScreenshotPath = testInfo.outputPath('updater-source-switching.png')
  let electronApp: ElectronApplication | null = null

  await fs.mkdir(legacyRoot, { recursive: true })

  try {
    electronApp = await launchTestApp(dataRoot, legacyRoot)
    const mainPage = await electronApp.firstWindow()
    const searchInput = mainPage.locator('.search-input')
    await expect(searchInput).toBeVisible()

    // 导航到“关于 ZTools”设置页并等待正文稳定特征渲染完成。
    await searchInput.fill('关于 ZTools')
    const aboutResult = mainPage
      .locator('.app-item, .list-item')
      .filter({ hasText: '关于 ZTools' })
      .first()
    await expect(aboutResult).toBeVisible()
    await aboutResult.click()
    await expect
      .poll(() => readSettingsText(electronApp!), { timeout: 15_000 })
      .toContain('检查更新')

    // 打开右上角“更新选项”菜单，验证默认源与关闭官方提示开关持久化。
    const prefsAfterToggle = await executeInSettings(
      electronApp,
      `(async () => {
        const btn = document.querySelector('button[aria-label="更新选项"]')
        if (!(btn instanceof HTMLButtonElement)) throw new Error('未找到更新选项按钮')
        btn.click()
        await new Promise((resolve) => setTimeout(resolve, 150))

        const select = document.querySelector('select[aria-label="选择默认更新源"]')
        if (!(select instanceof HTMLSelectElement)) throw new Error('未找到默认更新源选择框')
        if (select.value !== 'mine') {
          throw new Error('期望默认更新源为 mine，实际为: ' + select.value)
        }

        const menu = document.querySelector('.update-options-menu')
        const checkboxes = menu ? Array.from(menu.querySelectorAll('input[type="checkbox"]')) : []
        const ignoreInput = checkboxes[0]
        if (!(ignoreInput instanceof HTMLInputElement)) throw new Error('未找到关闭官方新版本提示开关')
        ignoreInput.click()
        await new Promise((resolve) => setTimeout(resolve, 200))

        return await window.ztools.internal.updaterGetPreferences()
      })()`
    )
    expect(prefsAfterToggle).toEqual({
      preferredUpdateSource: 'mine',
      ignoreOfficialUpdateNotice: true
    })

    // 仅截取设置插件 WebContentsView 当前可见区域。
    const aboutPngBase64 = await electronApp.evaluate(async ({ webContents }, urlFragments) => {
      const settingsContents = webContents
        .getAllWebContents()
        .find((contents) => urlFragments.some((fragment) => contents.getURL().includes(fragment)))
      if (!settingsContents) throw new Error('未找到设置插件 WebContentsView')
      return (await settingsContents.capturePage()).toPNG().toString('base64')
    }, settingsUrlFragments)
    const aboutPng = Buffer.from(aboutPngBase64, 'base64')
    await fs.writeFile(aboutScreenshotPath, aboutPng)
    await testInfo.attach('about-update-options', {
      body: aboutPng,
      contentType: 'image/png'
    })

    // 打开真实 updater.html 窗口验证下载中/已下载/异常态下可自由切源及合并影响提示渲染。
    const preloadPath = path.join(projectRoot, 'out/preload/index.js')
    const updaterHtmlPath = path.join(projectRoot, 'out/renderer/updater.html')
    const updateWindowPromise = electronApp.waitForEvent('window')
    await electronApp.evaluate(
      ({ BrowserWindow }, paths) => {
        const win = new BrowserWindow({
          width: 500,
          height: 450,
          show: true,
          webPreferences: {
            preload: paths.preloadPath,
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false
          }
        })
        void win.loadFile(paths.updaterHtmlPath)
      },
      { preloadPath, updaterHtmlPath }
    )

    const updatePage = await updateWindowPromise
    await updatePage.waitForLoadState('domcontentloaded')

    const mockUpdatePayload = {
      version: '3.3.0',
      currentVersion: '0.0.1',
      changelog: '### 官方 v3.3.0 更新日志\n- 优化主搜索栏体验',
      origin: 'official',
      preferredOrigin: 'official',
      preferences: {
        preferredUpdateSource: 'mine',
        ignoreOfficialUpdateNotice: true
      },
      sources: [
        {
          id: -100,
          platformName: '我的源 (flycodeu/ZTools)',
          downloadUrl: 'https://github.com/flycodeu/ZTools/releases/tag/v0.0.2',
          isDirect: true,
          feedUrl: 'https://github.com/flycodeu/ZTools/releases/download/v0.0.2',
          origin: 'mine',
          version: '0.0.2',
          changelog: '### 我的源 v0.0.2\n- 新增自定义插件增强'
        },
        {
          id: 1,
          platformName: '官方源',
          downloadUrl: 'https://official.example/setup.exe',
          isDirect: true,
          feedUrl: 'https://official.example/feed',
          origin: 'official',
          version: '3.3.0',
          changelog: '### 官方 v3.3.0 更新日志\n- 优化主搜索栏体验'
        },
        {
          id: 2,
          platformName: 'GitHub',
          downloadUrl: 'https://github.com/ZToolsCenter/ZTools/releases/tag/v3.3.0',
          isDirect: false,
          origin: 'official',
          version: '3.3.0',
          changelog: '### 官方 v3.3.0 更新日志\n- 优化主搜索栏体验'
        }
      ],
      forkAnalysis: {
        currentVersion: '0.0.1',
        upstreamBaseVersion: '3.2.0',
        upstreamBaseCommit: 'a4d0459',
        mySource: {
          repo: 'flycodeu/ZTools',
          latestVersion: '0.0.2',
          hasUpdate: true,
          releaseUrl: 'https://github.com/flycodeu/ZTools/releases/tag/v0.0.2',
          changelog: '### 我的源 v0.0.2'
        },
        officialSource: {
          repo: 'ZToolsCenter/ZTools',
          latestVersion: '3.3.0',
          hasNewerThanBase: true,
          hasNewerThanLocal: true,
          releaseUrl: 'https://github.com/ZToolsCenter/ZTools/releases/tag/v3.3.0',
          changelog: '### 官方 v3.3.0'
        },
        mergeImpact: {
          level: 'high',
          canDirectMerge: false,
          summary:
            '官方 v3.3.0 与您修改的 src/main/api/updater.ts 存在重叠，建议评估后决定是否合并。',
          reasons: ['官方领先当前基线 8 个提交', '存在 1 个重叠修改文件'],
          upstreamCommitsAhead: 8,
          upstreamCommitsBehind: 0,
          forkCommitsAhead: 2,
          forkChangedFiles: ['src/main/api/updater.ts'],
          upstreamChangedFiles: ['src/main/api/updater.ts'],
          overlapFiles: ['src/main/api/updater.ts'],
          forkOnlyIsolatedChanges: false,
          upstreamCoreOrDependencyChanged: false
        },
        checkedAt: Date.now()
      }
    }

    await electronApp.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('updater.html')
      )
      if (!win) throw new Error('未找到 updater.html 测试窗口')
      win.webContents.send('update-info', payload)
    }, mockUpdatePayload)

    const sourceSelect = updatePage.locator('#update-source')
    await expect(updatePage.locator('.impact-banner')).toBeVisible()
    await expect(updatePage.locator('.impact-badge')).toContainText('影响较大')
    await expect(sourceSelect).toHaveValue('1')
    await expect(sourceSelect).toBeEnabled()

    // 模拟已进入下载中与已下载完成状态，验证下载渠道下拉框不再被锁死且可切换重置状态。
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('updater.html')
      )
      win?.webContents.send('update-download-start', { version: '3.3.0' })
      win?.webContents.send('update-download-progress', {
        percent: 55,
        transferred: 5_500_000,
        total: 10_000_000
      })
    })
    await expect(updatePage.locator('.update-status')).toContainText('55%')
    await expect(sourceSelect).toBeEnabled()

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('updater.html')
      )
      win?.webContents.send('update-downloaded', { version: '3.3.0' })
    })
    await expect(updatePage.locator('.confirm')).toContainText('立即安装')
    await expect(sourceSelect).toBeEnabled()

    // 从“官方源 (1)”自由切换到“我的源 (-100)”，确认版本与更新日志联动切换并重置下载态。
    await sourceSelect.selectOption('-100')
    await expect(updatePage.locator('.title')).toContainText('0.0.2')
    await expect(updatePage.locator('.changelog')).toContainText('新增自定义插件增强')
    await expect(updatePage.locator('.confirm')).toContainText('下载并安装')

    // 验证较长的“我的源”文案被截断约束在左侧区域内，不与“稍后更新”按钮重叠。
    const selectBox = await sourceSelect.boundingBox()
    const cancelBox = await updatePage.locator('.btn.cancel').boundingBox()
    expect(selectBox).not.toBeNull()
    expect(cancelBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(cancelBox!.x)

    const updaterScreenshot = await updatePage.screenshot({ path: updaterScreenshotPath })
    await testInfo.attach('updater-source-switching', {
      body: updaterScreenshot,
      contentType: 'image/png'
    })
  } finally {
    if (electronApp) await electronApp.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
