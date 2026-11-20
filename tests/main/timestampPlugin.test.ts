import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { BUNDLED_INTERNAL_PLUGIN_NAMES } from '../../src/main/core/internalPlugins'

interface TimestampPluginConfig {
  name: string
  title: string
  main: string
  logo: string
  features: Array<{ code: string; icon: string; cmds: string[] }>
}

describe('bundled timestamp plugin', () => {
  const pluginRoot = path.join(process.cwd(), 'internal-plugins', 'timestamp', 'public')
  const config = JSON.parse(
    readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')
  ) as TimestampPluginConfig

  it('is loaded as a separate bundled plugin with searchable commands', () => {
    expect(BUNDLED_INTERNAL_PLUGIN_NAMES).toContain('timestamp')
    expect(config.name).toBe('timestamp')
    expect(config.title).toBe('时间戳')
    expect(config.logo).toBe('clock.png')
    expect(config.features).toEqual([
      expect.objectContaining({
        code: 'timestamp',
        icon: 'clock.svg',
        cmds: expect.arrayContaining(['时间戳', '时间戳计算', '时间转换', 'Timestamp'])
      })
    ])
  })

  it('contains a self-contained plugin entry and browser assets', () => {
    expect(existsSync(path.join(pluginRoot, config.main))).toBe(true)
    expect(existsSync(path.join(pluginRoot, 'app.js'))).toBe(true)
    expect(existsSync(path.join(pluginRoot, 'time.js'))).toBe(true)
    expect(existsSync(path.join(pluginRoot, 'style.css'))).toBe(true)
    expect(existsSync(path.join(pluginRoot, 'clock.png'))).toBe(true)
  })
})
