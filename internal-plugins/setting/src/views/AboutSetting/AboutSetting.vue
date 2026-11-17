<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useToast } from '@/components'
import {
  GITHUB_LATEST_RELEASE_URL,
  GITHUB_REPOSITORY_URL,
  type ForkUpdateAnalysis,
  type UpdateOrigin
} from '@shared/updateSource'

const { info, error, confirm } = useToast()

const appVersion = ref('')
const isCheckingUpdate = ref(false)
const isAnalyzingFork = ref(false)
const autoCheckUpdate = ref(true)
const receiveBetaUpdates = ref(false)
const preferredUpdateSource = ref<UpdateOrigin>('mine')
const ignoreOfficialUpdateNotice = ref(false)
const forkAnalysis = ref<ForkUpdateAnalysis | null>(null)
const showUpdateOptions = ref(false)
const currentYear = new Date().getFullYear()
const showUpdateOptionsMenu = computed(() => appVersion.value !== '' && appVersion.value !== '未知')
const showBetaUpdateOption = computed(
  () => appVersion.value !== '' && appVersion.value !== '未知' && !appVersion.value.includes('-')
)
const mergeImpactLabel = computed(() => {
  const level = forkAnalysis.value?.mergeImpact.level
  if (level === 'up-to-date') return '已包含官方改动'
  if (level === 'low') return '无冲突 · 可直接合并'
  if (level === 'medium') return '核心或依赖变更 · 需评估'
  if (level === 'high') return '存在重叠改动 · 建议自决'
  return '暂无法比对'
})

onMounted(async () => {
  await getAppVersion()
  await loadAutoCheckSetting()
  void refreshForkAnalysis(false, true)
  window.addEventListener('click', closeUpdateOptions)
  window.addEventListener('keydown', handleUpdateOptionsKeydown, true)
})

onUnmounted(() => {
  window.removeEventListener('click', closeUpdateOptions)
  window.removeEventListener('keydown', handleUpdateOptionsKeydown, true)
})

async function getAppVersion(): Promise<void> {
  try {
    appVersion.value = await window.ztools.internal.getAppVersion()
  } catch (err) {
    console.error('获取版本失败:', err)
    appVersion.value = '未知'
  }
}

/**
 * 刷新“我的源”与“官方源”的版本差距及合并影响分析结果。
 * @param forceRefresh 为 true 时忽略主进程短时缓存重新拉取远端数据。
 * @param silent 静默刷新失败时不弹出错误提示（用于页面首次挂载）。
 * @returns 分析刷新完成后结束的 Promise。
 */
async function refreshForkAnalysis(forceRefresh = true, silent = false): Promise<void> {
  if (isAnalyzingFork.value) return
  isAnalyzingFork.value = true
  try {
    forkAnalysis.value = await window.ztools.internal.updaterAnalyzeFork(forceRefresh)
  } catch (err: any) {
    console.error('获取版本对比分析失败:', err)
    if (!silent) {
      error('版本对比分析失败: ' + (err?.message || '网络不可用'))
    }
  } finally {
    isAnalyzingFork.value = false
  }
}

async function handleCheckUpdate(): Promise<void> {
  if (isCheckingUpdate.value) return
  isCheckingUpdate.value = true

  try {
    const result = await window.ztools.internal.updaterCheckUpdate()
    if (result.forkAnalysis) {
      forkAnalysis.value = result.forkAnalysis
    }
    if (result.migrationRequired) {
      const shouldOpenRelease = await confirm({
        title: '需要更新 ZTools',
        message:
          '当前版本使用的是较早的更新方式，请安装一次最新完整版本。您的数据、设置和插件都会保留。',
        type: 'info',
        confirmText: '下载最新版本',
        cancelText: '稍后'
      })
      if (shouldOpenRelease) {
        window.ztools.shellOpenExternal(result.releaseUrl || GITHUB_LATEST_RELEASE_URL)
      }
      return
    }
    if (!result.hasUpdate) {
      if (result.error) {
        error('检查更新出错: ' + result.error)
      } else if (
        result.forkAnalysis?.officialSource.hasNewerThanBase &&
        ignoreOfficialUpdateNotice.value
      ) {
        info('我的源已是最新版（已开启关闭官方新版本提示，可在下方查看官方版本差距）')
      } else {
        info('当前已是最新版本')
      }
    }
  } catch (err: any) {
    console.error('检查更新失败:', err)
    error('检查更新失败: ' + (err.message || '未知错误'))
  } finally {
    isCheckingUpdate.value = false
  }
}

/**
 * 在系统浏览器中打开外部链接。
 * @param url 要打开的 HTTPS 地址。
 * @returns 无返回值。
 */
function openExternalUrl(url: string): void {
  if (!url) return
  window.ztools.shellOpenExternal(url)
}

function openQQGroup(): void {
  window.ztools.shellOpenExternal('https://qm.qq.com/q/fXCzbh3Txe')
}

function openGithub(): void {
  window.ztools.shellOpenExternal(GITHUB_REPOSITORY_URL)
}

function openSponsor(): void {
  window.ztools.shellOpenExternal('https://afdian.com/a/ZTools')
}

async function loadAutoCheckSetting(): Promise<void> {
  try {
    const [data, prefs] = await Promise.all([
      window.ztools.internal.dbGet('settings-general'),
      window.ztools.internal.updaterGetPreferences().catch(() => null)
    ])
    if (data) {
      autoCheckUpdate.value = data.autoCheckUpdate ?? true
      receiveBetaUpdates.value = data.receiveBetaUpdates === true
      preferredUpdateSource.value = data.preferredUpdateSource === 'official' ? 'official' : 'mine'
      ignoreOfficialUpdateNotice.value = data.ignoreOfficialUpdateNotice === true
    }
    if (prefs) {
      preferredUpdateSource.value = prefs.preferredUpdateSource
      ignoreOfficialUpdateNotice.value = prefs.ignoreOfficialUpdateNotice
    }
  } catch (err) {
    console.error('加载自动更新设置失败:', err)
  }
}

/**
 * 保存默认更新源偏好（“我的源”或“官方源”）并同步通知主进程。
 * @returns 偏好保存完成后结束的 Promise。
 */
async function handlePreferredUpdateSourceChange(): Promise<void> {
  try {
    const saved = await window.ztools.internal.updaterSetPreferences({
      preferredUpdateSource: preferredUpdateSource.value
    })
    preferredUpdateSource.value = saved.preferredUpdateSource
    info(
      saved.preferredUpdateSource === 'mine'
        ? '已切换默认更新源为“我的源”'
        : '已切换默认更新源为“官方源”'
    )
  } catch (err) {
    console.error('保存默认更新源失败:', err)
    error('默认更新源设置保存失败')
  }
}

/**
 * 保存“关闭官方新版本提示”开关并同步更新主窗口通知可见性。
 * @returns 偏好保存完成后结束的 Promise。
 */
async function handleIgnoreOfficialNoticeChange(): Promise<void> {
  try {
    const saved = await window.ztools.internal.updaterSetPreferences({
      ignoreOfficialUpdateNotice: ignoreOfficialUpdateNotice.value
    })
    ignoreOfficialUpdateNotice.value = saved.ignoreOfficialUpdateNotice
  } catch (err) {
    console.error('保存关闭官方提示设置失败:', err)
    error('官方提示开关保存失败')
  }
}

/**
 * 从对比卡片快捷切换“关闭官方新版本提示”状态。
 * @returns 切换与保存完成后结束的 Promise。
 */
async function toggleIgnoreOfficialFromCard(): Promise<void> {
  ignoreOfficialUpdateNotice.value = !ignoreOfficialUpdateNotice.value
  await handleIgnoreOfficialNoticeChange()
}

async function handleAutoCheckUpdateChange(): Promise<void> {
  try {
    // 更新数据库中的设置
    const data = (await window.ztools.internal.dbGet('settings-general')) || {}
    data.autoCheckUpdate = autoCheckUpdate.value
    await window.ztools.internal.dbPut('settings-general', data)
    // 通知主进程
    await window.ztools.internal.updaterSetAutoCheck(autoCheckUpdate.value)
  } catch (err) {
    console.error('更新自动检查更新设置失败:', err)
  }
}

/**
 * 打开或关闭更新高级选项菜单，并阻止当前点击触发外部关闭监听。
 * @param event 三点按钮的点击事件。
 * @returns 无返回值。
 */
function toggleUpdateOptions(event: MouseEvent): void {
  event.stopPropagation()
  showUpdateOptions.value = !showUpdateOptions.value
}

/**
 * 关闭更新高级选项菜单。
 * @returns 无返回值。
 */
function closeUpdateOptions(): void {
  showUpdateOptions.value = false
}

/**
 * 在更新高级选项打开时响应 Esc 键关闭菜单。
 * @param event 窗口键盘事件。
 * @returns 无返回值。
 */
function handleUpdateOptionsKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !showUpdateOptions.value) return
  event.stopPropagation()
  closeUpdateOptions()
}

/**
 * 保存 Beta 更新订阅偏好，并在开启时立即检查一次新版本。
 * @returns 设置保存和可选更新检查完成后的 Promise。
 */
async function handleReceiveBetaUpdatesChange(): Promise<void> {
  try {
    // 与自动检查更新共用设备级设置，确保自动和手动检查读取同一状态。
    const data = (await window.ztools.internal.dbGet('settings-general')) || {}
    data.receiveBetaUpdates = receiveBetaUpdates.value
    await window.ztools.internal.dbPut('settings-general', data)

    // 开启订阅后立即检查，避免用户等待下一次定时检查。
    if (receiveBetaUpdates.value && autoCheckUpdate.value) {
      await window.ztools.internal.updaterCheckUpdate()
    }
  } catch (err) {
    console.error('更新 Beta 版本订阅设置失败:', err)
    error('Beta 更新设置保存失败')
  }
}
</script>
<template>
  <div class="content-panel">
    <!-- 右上角自动检查更新 -->
    <div class="auto-update-row">
      <label class="auto-update-label" for="auto-check-update">自动检查更新</label>
      <label class="toggle">
        <input
          id="auto-check-update"
          v-model="autoCheckUpdate"
          type="checkbox"
          @change="handleAutoCheckUpdateChange"
        />
        <span class="toggle-slider"></span>
      </label>
      <div v-if="showUpdateOptionsMenu" class="update-options-wrapper" @click.stop>
        <button
          class="icon-btn update-options-button"
          type="button"
          title="更新选项"
          aria-label="更新选项"
          :aria-expanded="showUpdateOptions"
          @click="toggleUpdateOptions"
        >
          <div class="i-z-more" />
        </button>
        <Transition name="update-options">
          <div v-if="showUpdateOptions" class="update-options-menu" role="menu">
            <div class="update-options-item">
              <div class="update-options-copy">
                <span>默认更新源</span>
                <small>默认优先检查并下载我的源，仍支持在更新窗切换</small>
              </div>
              <select
                v-model="preferredUpdateSource"
                class="source-preference-select"
                aria-label="选择默认更新源"
                @change="handlePreferredUpdateSourceChange"
              >
                <option value="mine">我的源</option>
                <option value="official">官方源</option>
              </select>
            </div>
            <div class="update-options-item">
              <div class="update-options-copy">
                <span>关闭官方新版本提示</span>
                <small>开启后不再自动弹出官方更新提示，仅提示我的源</small>
              </div>
              <label class="toggle beta-update-toggle">
                <input
                  v-model="ignoreOfficialUpdateNotice"
                  type="checkbox"
                  @change="handleIgnoreOfficialNoticeChange"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div v-if="showBetaUpdateOption" class="update-options-item">
              <div class="update-options-copy">
                <span>接收 Beta 版本更新</span>
                <small>开启后，正式版也会接收测试版本</small>
              </div>
              <label class="toggle beta-update-toggle">
                <input
                  v-model="receiveBetaUpdates"
                  type="checkbox"
                  @change="handleReceiveBetaUpdatesChange"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <div class="about-container">
      <!-- Logo -->
      <div class="about-logo">
        <img src="/logo.png" alt="ZTools" draggable="false" />
      </div>

      <!-- 应用名称 -->
      <h1 class="about-title">ZTools</h1>

      <!-- 版本号 -->
      <div class="about-version">v{{ appVersion }}</div>

      <!-- 信息卡片 -->
      <div class="about-cards">
        <div class="about-card">
          <div class="card-icon card-icon-author">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <circle
                cx="12"
                cy="7"
                r="4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">作者</div>
          <div class="card-value">Zing</div>
        </div>

        <div class="about-card clickable" @click="openQQGroup">
          <div class="card-icon card-icon-qq">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M21 11.5C21.0034 12.8199 20.6951 14.1219 20.1 15.3C19.3944 16.7118 18.3098 17.8992 16.9674 18.7293C15.6251 19.5594 14.0782 19.9994 12.5 20C11.1801 20.0034 9.87812 19.6951 8.7 19.1L3 21L4.9 15.3C4.30493 14.1219 3.99656 12.8199 4 11.5C4.00061 9.92179 4.44061 8.37488 5.27072 7.03258C6.10083 5.69028 7.28825 4.6056 8.7 3.90003C9.87812 3.30496 11.1801 2.99659 12.5 3.00003H13C15.0843 3.11502 17.053 3.99479 18.5291 5.47089C20.0052 6.94699 20.885 8.91568 21 11V11.5Z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">QQ 交流群</div>
          <div class="card-value">
            1076942619
            <svg class="external-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 13V19C18 19.5304 17.7893 20.0391 17.4142 20.4142C17.0391 20.7893 16.5304 21 16 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V8C3 7.46957 3.21071 6.96086 3.58579 6.58579C3.96086 6.21071 4.46957 6 5 6H11"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M15 3H21V9"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M10 14L21 3"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>

        <div class="about-card clickable" @click="openGithub">
          <div class="card-icon card-icon-github">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 19C4 20.5 4 16.5 2 16M16 22V18.13C16.0375 17.6532 15.9731 17.1738 15.811 16.7238C15.6489 16.2738 15.3929 15.8634 15.06 15.52C18.2 15.17 21.5 13.98 21.5 8.52C21.4997 7.12383 20.9627 5.7812 20 4.77C20.4559 3.54851 20.4236 2.19835 19.91 1C19.91 1 18.73 0.650001 16 2.48C13.708 1.85882 11.292 1.85882 9 2.48C6.27 0.650001 5.09 1 5.09 1C4.57638 2.19835 4.54414 3.54851 5 4.77C4.03013 5.7887 3.49252 7.14346 3.5 8.55C3.5 13.97 6.8 15.16 9.94 15.55C9.611 15.89 9.35726 16.2954 9.19531 16.7399C9.03335 17.1844 8.96681 17.658 9 18.13V22"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">开源地址</div>
          <div class="card-value">
            查看代码
            <svg class="external-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 13V19C18 19.5304 17.7893 20.0391 17.4142 20.4142C17.0391 20.7893 16.5304 21 16 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V8C3 7.46957 3.21071 6.96086 3.58579 6.58579C3.96086 6.21071 4.46957 6 5 6H11"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M15 3H21V9"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M10 14L21 3"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>

        <div class="about-card clickable" @click="openSponsor">
          <div class="card-icon card-icon-sponsor">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M20.84 4.61C20.3292 4.099 19.7228 3.69364 19.0554 3.41708C18.3879 3.14052 17.6725 2.99817 16.95 2.99817C16.2275 2.99817 15.5121 3.14052 14.8446 3.41708C14.1772 3.69364 13.5708 4.099 13.06 4.61L12 5.67L10.94 4.61C9.9083 3.57831 8.50903 2.99871 7.05 2.99871C5.59096 2.99871 4.19169 3.57831 3.16 4.61C2.1283 5.6417 1.54871 7.04097 1.54871 8.5C1.54871 9.95903 2.1283 11.3583 3.16 12.39L4.22 13.45L12 21.23L19.78 13.45L20.84 12.39C21.351 11.8792 21.7563 11.2728 22.0329 10.6054C22.3095 9.93789 22.4518 9.22249 22.4518 8.5C22.4518 7.77751 22.3095 7.0621 22.0329 6.39464C21.7563 5.72718 21.351 5.12075 20.84 4.61Z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">赞助支持</div>
          <div class="card-value">支持作者</div>
        </div>
      </div>

      <!-- 核心技术 -->
      <div class="about-techs">
        <span class="tech-tag">Electron 41</span>
        <span class="tech-tag">Vue 3</span>
        <span class="tech-tag">TypeScript</span>
        <span class="tech-tag">LMDB</span>
        <span class="tech-tag">Fuse.js</span>
      </div>

      <!-- 检查更新按钮 -->
      <button class="check-update-btn" :disabled="isCheckingUpdate" @click="handleCheckUpdate">
        <svg v-if="!isCheckingUpdate" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M23 4V10H17"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M20.49 15C19.84 16.8399 18.6096 18.4187 16.9842 19.4985C15.3588 20.5783 13.4315 21.1006 11.4952 20.9866C9.55886 20.8726 7.70756 20.1286 6.22015 18.8667C4.73274 17.6047 3.6894 15.8932 3.24965 13.9901C2.8099 12.087 2.99716 10.0952 3.78477 8.30479C4.57238 6.51435 5.91702 5.02117 7.61403 4.04909C9.31105 3.07702 11.27 2.67856 13.2091 2.91282C15.1481 3.14708 16.9632 4.0015 18.36 5.35L23 10"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 2V6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path
            d="M12 18V22"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.3"
          />
          <path
            d="M4.93 4.93L7.76 7.76"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
          <path
            d="M16.24 16.24L19.07 19.07"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.3"
          />
          <path
            d="M2 12H6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.5"
          />
          <path
            d="M18 12H22"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.5"
          />
          <path
            d="M4.93 19.07L7.76 16.24"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.3"
          />
          <path
            d="M16.24 7.76L19.07 4.93"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        {{ isCheckingUpdate ? '检查中...' : '检查更新' }}
      </button>

      <!-- 双源对比与官方版本差距评估卡片 -->
      <div v-if="forkAnalysis" class="fork-analysis-card">
        <div class="fork-analysis-header">
          <div class="fork-analysis-title-group">
            <span class="fork-analysis-title">更新源对比与合并评估</span>
            <span class="fork-base-pill">
              基线 v{{ forkAnalysis.upstreamBaseVersion }} ({{ forkAnalysis.upstreamBaseCommit }})
            </span>
          </div>
          <button
            type="button"
            class="fork-refresh-btn"
            :disabled="isAnalyzingFork"
            @click="refreshForkAnalysis(true, false)"
          >
            {{ isAnalyzingFork ? '比对中...' : '重新比对' }}
          </button>
        </div>

        <div class="fork-source-grid">
          <div class="fork-source-box">
            <div class="fork-source-top">
              <span class="fork-source-name">我的源 ({{ forkAnalysis.mySource.repo }})</span>
              <span
                class="fork-status-tag"
                :class="forkAnalysis.mySource.hasUpdate ? 'is-update' : 'is-latest'"
              >
                {{ forkAnalysis.mySource.hasUpdate ? '有新版本' : '已最新' }}
              </span>
            </div>
            <div class="fork-source-version">
              {{
                forkAnalysis.mySource.latestVersion
                  ? `v${forkAnalysis.mySource.latestVersion}`
                  : '暂无远端版本'
              }}
            </div>
            <button
              type="button"
              class="fork-link-btn"
              @click="openExternalUrl(forkAnalysis.mySource.releaseUrl)"
            >
              打开发布页
            </button>
          </div>

          <div class="fork-source-box">
            <div class="fork-source-top">
              <span class="fork-source-name">官方源 ({{ forkAnalysis.officialSource.repo }})</span>
              <span
                class="fork-status-tag"
                :class="
                  forkAnalysis.officialSource.hasNewerThanBase ? 'is-upstream-ahead' : 'is-latest'
                "
              >
                {{ forkAnalysis.officialSource.hasNewerThanBase ? '有新改动' : '已包含' }}
              </span>
            </div>
            <div class="fork-source-version">
              {{
                forkAnalysis.officialSource.latestVersion
                  ? `v${forkAnalysis.officialSource.latestVersion}`
                  : '暂未获取'
              }}
            </div>
            <button
              type="button"
              class="fork-link-btn"
              @click="openExternalUrl(forkAnalysis.officialSource.releaseUrl)"
            >
              打开发布页
            </button>
          </div>
        </div>

        <div class="fork-impact-panel" :class="`level-${forkAnalysis.mergeImpact.level}`">
          <div class="fork-impact-head">
            <span class="fork-impact-badge" :class="`level-${forkAnalysis.mergeImpact.level}`">
              {{ mergeImpactLabel }}
            </span>
            <button
              v-if="forkAnalysis.officialSource.hasNewerThanBase || ignoreOfficialUpdateNotice"
              type="button"
              class="fork-ignore-btn"
              @click="toggleIgnoreOfficialFromCard"
            >
              {{ ignoreOfficialUpdateNotice ? '已关闭官方提示（点击开启）' : '关闭官方新版本提示' }}
            </button>
          </div>
          <p class="fork-impact-summary">{{ forkAnalysis.mergeImpact.summary }}</p>
          <ul v-if="forkAnalysis.mergeImpact.reasons.length > 0" class="fork-impact-reasons">
            <li
              v-for="(reason, index) in forkAnalysis.mergeImpact.reasons.slice(0, 4)"
              :key="index"
            >
              {{ reason }}
            </li>
          </ul>
          <div v-if="forkAnalysis.mergeImpact.overlapFiles.length > 0" class="fork-overlap-files">
            可能冲突文件：{{ forkAnalysis.mergeImpact.overlapFiles.slice(0, 5).join('、')
            }}<span v-if="forkAnalysis.mergeImpact.overlapFiles.length > 5">
              等 {{ forkAnalysis.mergeImpact.overlapFiles.length }} 个文件</span
            >
          </div>
        </div>
      </div>

      <!-- 版权信息 -->
      <div class="about-copyright">
        Copyright &copy; 2025-{{ currentYear }} ZTools. All rights reserved.
      </div>
    </div>
  </div>
</template>

<style scoped>
.content-panel {
  position: relative;
  height: 100%;
}

.about-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 32px 32px;
  box-sizing: border-box;
}

.about-logo {
  width: 96px;
  height: 96px;
  margin-bottom: 16px;
}

.about-logo img {
  width: 100%;
  height: 100%;
  border-radius: 22px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
}

.about-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-color);
  margin: 0 0 6px;
}

.about-version {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 28px;
}

/* 卡片区域 */
.about-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  width: 100%;
  max-width: 560px;
  margin-bottom: 24px;
}

.about-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 12px 16px;
  border-radius: 12px;
  border: 1px solid var(--control-border);
  background: var(--card-bg);
  transition: all 0.2s;
}

.about-card.clickable {
  cursor: pointer;
}

.about-card.clickable:hover {
  border-color: var(--primary-color);
  background: var(--active-bg);
}

.card-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
}

.card-icon-author {
  background: #e0f2fe;
  color: #0284c7;
}

.card-icon-qq {
  background: #dcfce7;
  color: #16a34a;
}

.card-icon-github {
  background: #f3f4f6;
  color: #374151;
}

.card-icon-sponsor {
  background: #fce7f3;
  color: #ec4899;
}

.card-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.card-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color);
  display: flex;
  align-items: center;
  gap: 4px;
}

.external-icon {
  color: var(--text-secondary);
}

/* 核心技术标签 */
.about-techs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-bottom: 28px;
}

.tech-tag {
  padding: 5px 14px;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  border: 1px solid var(--control-border);
  background: var(--card-bg);
}

/* 检查更新按钮 */
.check-update-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 32px;
  border-radius: 10px;
  border: none;
  background: #10b981;
  color: var(--text-on-primary);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 24px;
}

.check-update-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
}

.check-update-btn:active:not(:disabled) {
  transform: translateY(0);
}

.check-update-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* 自动检查更新 */
.auto-update-row {
  position: absolute;
  top: 16px;
  right: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 1;
}

.auto-update-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.update-options-wrapper {
  position: relative;
}

.update-options-button {
  font-size: 17px;
}

.update-options-button:hover,
.update-options-button[aria-expanded='true'] {
  background: var(--hover-bg);
  color: var(--primary-color);
}

.update-options-menu {
  position: absolute;
  top: calc(100% + 7px);
  right: 0;
  width: 312px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  border: 1px solid var(--divider-color);
  border-radius: 7px;
  background: var(--dialog-bg);
  box-shadow: 0 10px 28px var(--shadow-color);
  padding: 13px 14px;
  color: var(--text-color);
}

.update-options-item {
  display: flex;
  align-items: center;
  gap: 14px;
}

.source-preference-select {
  flex: none;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--control-border);
  background: var(--card-bg);
  color: var(--text-color);
  font-size: 12px;
  outline: none;
  cursor: pointer;
}

.fork-analysis-card {
  width: 100%;
  max-width: 640px;
  margin-bottom: 24px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--divider-color);
  background: var(--card-bg);
  text-align: left;
  box-sizing: border-box;
}

.fork-analysis-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.fork-analysis-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fork-analysis-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color);
}

.fork-base-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--hover-bg);
}

.fork-refresh-btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--control-border);
  background: transparent;
  color: var(--text-color);
  font-size: 12px;
  cursor: pointer;
}

.fork-refresh-btn:hover:not(:disabled) {
  background: var(--hover-bg);
}

.fork-refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.fork-source-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.fork-source-box {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--control-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fork-source-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.fork-source-name {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fork-status-tag {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  font-weight: 500;
}

.fork-status-tag.is-latest {
  background: rgba(16, 185, 129, 0.14);
  color: #10b981;
}

.fork-status-tag.is-update,
.fork-status-tag.is-upstream-ahead {
  background: rgba(59, 130, 246, 0.14);
  color: #3b82f6;
}

.fork-source-version {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-color);
}

.fork-link-btn {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--primary-color);
  font-size: 12px;
  cursor: pointer;
}

.fork-link-btn:hover {
  text-decoration: underline;
}

.fork-impact-panel {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--divider-color);
  background: var(--hover-bg);
}

.fork-impact-panel.level-low,
.fork-impact-panel.level-up-to-date {
  border-color: rgba(16, 185, 129, 0.32);
}

.fork-impact-panel.level-medium {
  border-color: rgba(245, 158, 11, 0.36);
}

.fork-impact-panel.level-high {
  border-color: rgba(239, 68, 68, 0.36);
}

.fork-impact-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.fork-impact-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.14);
  color: #3b82f6;
}

.fork-impact-badge.level-low,
.fork-impact-badge.level-up-to-date {
  background: rgba(16, 185, 129, 0.14);
  color: #10b981;
}

.fork-impact-badge.level-medium {
  background: rgba(245, 158, 11, 0.16);
  color: #d97706;
}

.fork-impact-badge.level-high {
  background: rgba(239, 68, 68, 0.16);
  color: #dc2626;
}

.fork-ignore-btn {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--control-border);
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.fork-ignore-btn:hover {
  color: var(--text-color);
}

.fork-impact-summary {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-color);
  line-height: 1.5;
}

.fork-impact-reasons {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.55;
}

.fork-overlap-files {
  margin-top: 6px;
  font-size: 12px;
  color: #dc2626;
  word-break: break-all;
}

.update-options-copy {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 4px;
}

.update-options-copy span {
  font-size: 13px;
  font-weight: 600;
}

.update-options-copy small {
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.45;
}

.beta-update-toggle {
  flex: none;
}

.update-options-enter-active,
.update-options-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.update-options-enter-from,
.update-options-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 版权信息 */
.about-copyright {
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.6;
}

/* 暗色模式适配 */
@media (prefers-color-scheme: dark) {
  .card-icon-author {
    background: rgba(2, 132, 199, 0.15);
  }

  .card-icon-qq {
    background: rgba(22, 163, 74, 0.15);
  }

  .card-icon-github {
    background: rgba(255, 255, 255, 0.1);
    color: #d1d5db;
  }

  .card-icon-sponsor {
    background: rgba(236, 72, 153, 0.15);
  }
}
</style>
