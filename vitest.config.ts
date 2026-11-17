import { defineConfig, type Plugin } from 'vitest/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))

/**
 * 为 Vitest 提供 `.node?asset` 虚拟模块解析，模拟 electron-vite 的资源路径导出行为，
 * 避免原生二进制文件被 `vite:import-analysis` 当作 JS 源码解析。
 *
 * @returns Vitest Vite 插件实例。
 */
function createNativeNodeAssetPlugin(): Plugin {
  const virtualPrefix = '\0native-asset:'

  return {
    name: 'ztools-vitest-native-asset',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('.node?asset')) return null
      const rawPath = source.slice(0, -'?asset'.length)
      const resolvedPath = importer ? resolve(importer, '..', rawPath) : resolve(rawPath)
      return `${virtualPrefix}${resolvedPath}`
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return null
      const assetPath = id.slice(virtualPrefix.length)
      return `export default ${JSON.stringify(assetPath)}`
    }
  }
}

export default defineConfig({
  plugins: [createNativeNodeAssetPlugin()],
  define: {
    __ZTOOLS_TARGET_ELECTRON_VERSION__: JSON.stringify(packageJson.devDependencies.electron)
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  }
})
