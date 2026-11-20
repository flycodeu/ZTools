import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')

/**
 * 使用隔离目录启动源码版 ZTools，供时间戳插件端到端测试使用。
 * @param dataRoot 本次测试专用数据目录。
 * @param legacyRoot 本次测试专用旧数据目录。
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
      ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot
    }
  })
}

/**
 * 在时间戳插件 WebContents 中读取稳定的正文内容。
 * @param electronApp 当前隔离 Electron 应用。
 * @returns 时间戳插件页面正文。
 */
async function readTimestampPluginText(electronApp: ElectronApplication): Promise<string> {
  return await electronApp.evaluate(async ({ webContents }) => {
    const plugin = webContents
      .getAllWebContents()
      .find((contents) =>
        contents.getURL().includes('/internal-plugins/timestamp/public/index.html')
      )
    if (!plugin || plugin.isLoading()) return ''
    return await plugin.executeJavaScript(`(() => {
      const clock = document.getElementById('current-seconds')?.textContent
      return clock ? document.body?.innerText || '' : ''
    })()`)
  })
}

/**
 * 读取插件实时秒时间戳，供测试等待页面初始化完成。
 * @param electronApp 当前隔离 Electron 应用。
 * @returns 页面显示的 Unix 秒时间戳。
 */
async function readCurrentSeconds(electronApp: ElectronApplication): Promise<string> {
  return await electronApp.evaluate(({ webContents }) => {
    const plugin = webContents
      .getAllWebContents()
      .find((contents) =>
        contents.getURL().includes('/internal-plugins/timestamp/public/index.html')
      )!
    return plugin.executeJavaScript('document.getElementById("current-seconds")?.textContent || ""')
  })
}

test('时间戳内置插件可转换日期、解析时间戳并计算时间间隔', async ({
  browserName: _browserName
}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-timestamp-plugin-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  let electronApp: ElectronApplication | null = null

  await fs.mkdir(legacyRoot, { recursive: true })

  try {
    electronApp = await launchTestApp(dataRoot, legacyRoot)
    const page = await electronApp.firstWindow()
    const searchInput = page.locator('.search-input')

    await expect(searchInput).toBeVisible()
    await searchInput.fill('时间戳')
    const timestampResult = page
      .locator('.app-item, .list-item')
      .filter({ hasText: '时间戳' })
      .first()
    await expect(timestampResult).toBeVisible()
    await timestampResult.click()
    await expect
      .poll(() => readTimestampPluginText(electronApp!), { timeout: 15_000 })
      .toContain('时间戳转换')
    await expect.poll(() => readCurrentSeconds(electronApp!), { timeout: 15_000 }).not.toBe('')

    const pluginScreenshot = await electronApp.evaluate(async ({ webContents }) => {
      const plugin = webContents
        .getAllWebContents()
        .find((contents) =>
          contents.getURL().includes('/internal-plugins/timestamp/public/index.html')
        )!
      return (await plugin.capturePage()).toPNG().toString('base64')
    })
    const screenshotBuffer = Buffer.from(pluginScreenshot, 'base64')
    await fs.writeFile(testInfo.outputPath('timestamp-plugin.png'), screenshotBuffer)
    await testInfo.attach('timestamp-plugin', {
      body: screenshotBuffer,
      contentType: 'image/png'
    })

    const conversion = await electronApp.evaluate(async ({ webContents }) => {
      const plugin = webContents
        .getAllWebContents()
        .find((contents) =>
          contents.getURL().includes('/internal-plugins/timestamp/public/index.html')
        )!
      return await plugin.executeJavaScript(`(() => {
        const date = document.getElementById('date-input')
        date.value = '2023-11-14T22:13:20'
        date.dispatchEvent(new Event('input', { bubbles: true }))
        const dateResult = document.getElementById('date-result-milliseconds').textContent
        document.querySelector('.result-row').click()
        const copyToast = document.getElementById('toast').textContent
        const stamp = document.getElementById('timestamp-input')
        stamp.value = '1700000000'
        stamp.dispatchEvent(new Event('input', { bubbles: true }))
        const parsedDate = document.getElementById('timestamp-result-date').textContent
        const localExpected = window.TimestampTime.formatLocalDateTime(1700000000000)
        document.querySelector('.tab[data-tab="calculate"]').click()
        const calculationVisible = !document.getElementById('calculate-panel').hidden
        const start = window.TimestampTime.fromLocalInput(document.getElementById('difference-start').value)
        document.getElementById('difference-end').value = window.TimestampTime.toLocalInput(start + 86400000)
        document.getElementById('difference-end').dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('arithmetic-date').value = '2023-11-14T22:13:20'
        document.getElementById('arithmetic-date').dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('duration-days').value = '1'
        document.getElementById('duration-days').dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('duration-hours').value = '2'
        document.getElementById('duration-hours').dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('duration-minutes').value = '3'
        document.getElementById('duration-minutes').dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('duration-seconds').value = '4'
        document.getElementById('duration-seconds').dispatchEvent(new Event('input', { bubbles: true }))
        return {
          dateResult,
          parsedDate,
          localExpected,
          expectedDateResult: String(window.TimestampTime.fromLocalInput(date.value)),
          difference: document.getElementById('difference-human').textContent,
          copyToast,
          calculationVisible,
          arithmetic: document.getElementById('arithmetic-result').textContent,
          expectedArithmetic: window.TimestampTime.formatLocalDateTime(
            window.TimestampTime.fromLocalInput(document.getElementById('arithmetic-date').value) + 93784000
          )
        }
      })()`)
    })

    expect(conversion.dateResult).toBe(conversion.expectedDateResult)
    expect(conversion.parsedDate).toBe(conversion.localExpected)
    expect(conversion.difference).toBe('+1天 00:00:00')
    expect(conversion.arithmetic).toBe(conversion.expectedArithmetic)
    expect(conversion.copyToast).toBe('已复制')
    expect(conversion.calculationVisible).toBe(true)
  } finally {
    await electronApp?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
