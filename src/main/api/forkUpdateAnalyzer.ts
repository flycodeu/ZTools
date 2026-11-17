import { app } from 'electron'
import yaml from 'yaml'
import {
  compareSemverVersions,
  FORK_GITHUB_LATEST_RELEASE_URL,
  FORK_OWNER,
  FORK_REPO,
  FORK_UPSTREAM_BASE,
  getForkGitHubReleaseUrl,
  getForkReleaseFeedUrl,
  getGitHubReleaseUrl,
  GITHUB_LATEST_RELEASE_URL,
  MY_UPDATE_SOURCE_ID,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
  type ForkUpdateAnalysis,
  type MergeImpactLevel,
  type UpdateOrigin
} from '../../shared/updateSource'
import { httpRequest } from '../utils/httpRequest'
import type { PlatformUpdateInfo, UpdateDownloadSource } from './platformUpdater/types'
import {
  fetchLatestServerUpdate,
  resolvePlatformUpdateInfo,
  type ServerUpdateInfo
} from './serverUpdateCatalog'
import { readFileSync } from 'fs'
import path from 'path'

interface GitHubReleaseAsset {
  name?: string
  browser_download_url?: string
}

interface GitHubReleaseResponse {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string
  assets?: GitHubReleaseAsset[]
}

interface GitHubCompareFile {
  filename?: string
}

interface GitHubCompareResponse {
  status?: string
  ahead_by?: number
  behind_by?: number
  total_commits?: number
  files?: GitHubCompareFile[]
}

export interface RepoLatestReleaseInfo {
  repo: string
  latestVersion: string | null
  changelog: string
  releaseUrl: string
  assetUrl?: string
  publishedAt?: number
  error?: string
}

export interface PackageDiffFlags {
  electronMajorChanged: boolean
  dependenciesChanged: boolean
}

export interface EvaluateMergeImpactInput {
  currentVersion: string
  officialVersion: string | null
  upstreamBaseVersion?: string
  upstreamBaseCommit?: string
  forkCommitsAhead: number
  upstreamCommitsAhead: number
  upstreamCommitsBehind: number
  forkChangedFiles: string[]
  upstreamChangedFiles: string[]
  packageChanges?: PackageDiffFlags
  compareSucceeded: boolean
}

export interface CombinedUpdateCheckResult {
  analysis: ForkUpdateAnalysis
  myRelease: RepoLatestReleaseInfo
  officialServerUpdate: ServerUpdateInfo | null
  officialPlatformInfo: PlatformUpdateInfo | null
  mergedSources: UpdateDownloadSource[]
}

const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ZTools-Updater'
}

const CORE_HOST_PATHS = [
  'src/main/index.ts',
  'src/main/appMain.ts',
  'src/main/core/lmdb/',
  'src/main/core/storage/',
  'src/main/managers/pluginManager.ts',
  'resources/preload.js'
]

/**
 * 判断运行环境及平台应该下载的安装包文件名特征。
 * @param assets GitHub Release 返回的附件列表。
 * @returns 最匹配当前系统的下载链接，未匹配到时返回 undefined。
 */
function pickPlatformAssetUrl(assets: GitHubReleaseAsset[] = []): string | undefined {
  const urls = assets
    .map((asset) => ({ name: (asset.name || '').toLowerCase(), url: asset.browser_download_url }))
    .filter((item): item is { name: string; url: string } => Boolean(item.name && item.url))

  if (process.platform === 'win32') {
    return (
      urls.find((item) => item.name.endsWith('-setup.exe'))?.url ??
      urls.find((item) => item.name.endsWith('.exe'))?.url ??
      urls.find((item) => item.name.endsWith('-win-x64.zip'))?.url
    )
  }

  if (process.platform === 'darwin') {
    const archTag = process.arch === 'arm64' ? 'arm64' : 'x64'
    return (
      urls.find((item) => item.name.includes(archTag) && item.name.endsWith('.dmg'))?.url ??
      urls.find((item) => item.name.endsWith('.dmg'))?.url
    )
  }

  return (
    urls.find((item) => item.name.endsWith('.appimage'))?.url ??
    urls.find((item) => item.name.endsWith('.deb'))?.url
  )
}

/**
 * 根据当前系统返回 electron-updater 元数据文件名。
 * @returns 平台对应的更新元数据文件名称。
 */
function getLatestMetadataFilename(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

/**
 * 安全发送 HTTP GET 请求，避免在离线或测试 Mock 缺少 net 模块时抛出未捕获异常。
 * @param url 目标请求地址。
 * @param headers 可选请求头。
 * @returns 解析后的响应数据；请求失败时返回 null。
 */
async function safeHttpGet(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const response = await httpRequest(url, { headers })
    return response?.data ?? null
  } catch {
    return null
  }
}

/**
 * 从 GitHub Releases 接口或 latest.yml 回退地址读取指定仓库的最新版本信息。
 * @param owner 仓库所有者。
 * @param repo 仓库名称。
 * @param includePrerelease 是否包含预发布版本。
 * @returns 最新版本、变更日志与下载链接信息。
 */
export async function fetchGitHubRepoLatestRelease(
  owner: string,
  repo: string,
  includePrerelease: boolean
): Promise<RepoLatestReleaseInfo> {
  const fullRepo = `${owner}/${repo}`
  const fallbackLatestUrl =
    owner === FORK_OWNER && repo === FORK_REPO
      ? FORK_GITHUB_LATEST_RELEASE_URL
      : GITHUB_LATEST_RELEASE_URL
  const buildTagUrl = (version: string): string =>
    owner === FORK_OWNER && repo === FORK_REPO
      ? getForkGitHubReleaseUrl(version)
      : getGitHubReleaseUrl(version)

  const apiUrl = includePrerelease
    ? `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`
    : `https://api.github.com/repos/${owner}/${repo}/releases/latest`

  const payload = await safeHttpGet(apiUrl, GITHUB_API_HEADERS)
  let release: GitHubReleaseResponse | undefined

  if (Array.isArray(payload)) {
    release = payload.find((item: GitHubReleaseResponse) => !item?.draft && item?.tag_name)
  } else if (payload && typeof payload === 'object' && payload.tag_name && !payload.draft) {
    release = payload as GitHubReleaseResponse
  }

  if (release?.tag_name) {
    const version = release.tag_name.trim().replace(/^v/i, '')
    const publishedAt = release.published_at ? Date.parse(release.published_at) : undefined
    return {
      repo: fullRepo,
      latestVersion: version,
      changelog: release.body?.trim() || '',
      releaseUrl: release.html_url || buildTagUrl(version),
      assetUrl: pickPlatformAssetUrl(release.assets),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : undefined
    }
  }

  // API 受限或暂无正式 Release 接口返回时，回退读取 latest.yml 元数据文件。
  const metadataUrl = `https://github.com/${owner}/${repo}/releases/latest/download/${getLatestMetadataFilename()}`
  const rawYaml = await safeHttpGet(metadataUrl, { 'User-Agent': 'ZTools-Updater' })
  if (typeof rawYaml === 'string') {
    try {
      const parsed = yaml.parse(rawYaml) as {
        version?: string
        releaseNotes?: string
        path?: string
        releaseDate?: string
      }
      if (parsed?.version) {
        const version = String(parsed.version).trim().replace(/^v/i, '')
        const publishedAt = parsed.releaseDate ? Date.parse(parsed.releaseDate) : undefined
        return {
          repo: fullRepo,
          latestVersion: version,
          changelog: typeof parsed.releaseNotes === 'string' ? parsed.releaseNotes : '',
          releaseUrl: buildTagUrl(version),
          assetUrl: parsed.path
            ? `https://github.com/${owner}/${repo}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(parsed.path)}`
            : undefined,
          publishedAt: Number.isFinite(publishedAt) ? publishedAt : undefined
        }
      }
    } catch {
      // 元数据格式损坏时走下方错误回退。
    }
  }

  return {
    repo: fullRepo,
    latestVersion: null,
    changelog: '',
    releaseUrl: fallbackLatestUrl,
    error: `无法获取 ${fullRepo} 最新发布版本`
  }
}

/**
 * 读取本地主工程 package.json，用于比对官方新版本是否修改了 Electron 或运行时依赖。
 * @returns 解析后的 package.json 对象；读取失败时返回 null。
 */
function readLocalPackageJson(): {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} | null {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 提取版本号中的主版本号数字，用于识别跨 Electron 主版本升级。
 * @param range 语义化版本或范围表达式（如 ^41.4.0）。
 * @returns 主版本号；无法解析时返回 null。
 */
function extractMajorVersion(range?: string): number | null {
  if (!range) return null
  const match = range.match(/(\d+)/)
  return match ? Number(match[1]) : null
}

/**
 * 对比官方目标标签中的 package.json 与本地依赖差异，识别是否仅有版本号改动。
 * @param officialTag 官方目标标签或分支名。
 * @returns Electron 主版本及依赖是否变化标记。
 */
async function inspectUpstreamPackageChanges(officialTag: string): Promise<PackageDiffFlags> {
  const localPkg = readLocalPackageJson()
  if (!localPkg) {
    return { electronMajorChanged: false, dependenciesChanged: true }
  }

  const rawPkg = await safeHttpGet(
    `https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/${encodeURIComponent(officialTag)}/package.json`
  )
  let remotePkg: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  } | null = null

  if (typeof rawPkg === 'string') {
    try {
      remotePkg = JSON.parse(rawPkg)
    } catch {
      remotePkg = null
    }
  } else if (rawPkg && typeof rawPkg === 'object') {
    remotePkg = rawPkg
  }

  if (!remotePkg) {
    return { electronMajorChanged: false, dependenciesChanged: true }
  }

  const localElectronMajor = extractMajorVersion(localPkg.devDependencies?.electron)
  const remoteElectronMajor = extractMajorVersion(remotePkg.devDependencies?.electron)
  const electronMajorChanged =
    localElectronMajor !== null &&
    remoteElectronMajor !== null &&
    localElectronMajor !== remoteElectronMajor

  const localDeps = JSON.stringify(localPkg.dependencies ?? {})
  const remoteDeps = JSON.stringify(remotePkg.dependencies ?? {})
  return {
    electronMajorChanged,
    dependenciesChanged: localDeps !== remoteDeps
  }
}

/**
 * 判断 fork 修改的文件是否全部位于隔离目录（自定义小插件、测试或文档）中。
 * @param files fork 相对上游基线改动的文件路径列表。
 * @returns 若所有非版本号文件都处于低耦合隔离目录，则返回 true。
 */
function areForkChangesIsolated(files: string[]): boolean {
  const meaningfulFiles = files.filter((file) => file !== 'package.json')
  if (meaningfulFiles.length === 0) return true

  return meaningfulFiles.every((file) => {
    if (file.startsWith('tests/') || file.startsWith('docs/')) return true
    // 新增独立内置插件目录（排除内置 setting 与 system）属于低耦合扩展。
    if (
      file.startsWith('internal-plugins/') &&
      !file.startsWith('internal-plugins/setting/') &&
      !file.startsWith('internal-plugins/system/')
    ) {
      return true
    }
    return false
  })
}

/**
 * 综合比较版本差距、重叠文件与核心依赖变更，计算官方新版本的合并影响评估结果。
 * @param input 双端版本、提交差与改动文件列表。
 * @returns 结构化的合并影响评估结论，供设置页与更新弹窗展示。
 */
export function evaluateMergeImpact(
  input: EvaluateMergeImpactInput
): ForkUpdateAnalysis['mergeImpact'] & { hasNewerThanBase: boolean } {
  const upstreamBaseVersion = input.upstreamBaseVersion ?? FORK_UPSTREAM_BASE.version
  const upstreamBaseCommit = input.upstreamBaseCommit ?? FORK_UPSTREAM_BASE.commit
  const isForkVersion = compareSemverVersions(input.currentVersion, '1.0.0') < 0

  if (!input.officialVersion) {
    return {
      hasNewerThanBase: false,
      level: 'unknown',
      canDirectMerge: false,
      summary: '暂未获取到官方最新版本信息，请稍后重试或继续使用我的源。',
      reasons: ['无法获取官方源最新版本'],
      upstreamCommitsAhead: 0,
      upstreamCommitsBehind: 0,
      forkCommitsAhead: input.forkCommitsAhead,
      forkChangedFiles: input.forkChangedFiles,
      upstreamChangedFiles: [],
      overlapFiles: [],
      forkOnlyIsolatedChanges: areForkChangesIsolated(input.forkChangedFiles),
      upstreamCoreOrDependencyChanged: false
    }
  }

  // 当 GitHub Compare 明确显示官方目标位于当前基线之前，或在离线状态下官方版本已包含于当前版本/基线时，
  // 不应当作“需要合并或升级的新版本”误报。
  const isAlreadyIncludedInBase = input.compareSucceeded
    ? input.upstreamCommitsAhead === 0
    : isForkVersion
      ? compareSemverVersions(input.officialVersion, upstreamBaseVersion) <= 0
      : compareSemverVersions(input.officialVersion, input.currentVersion) <= 0

  const forkOnlyIsolatedChanges = areForkChangesIsolated(input.forkChangedFiles)

  if (isAlreadyIncludedInBase) {
    const reasons = [
      `当前分支基于官方 v${upstreamBaseVersion}（${upstreamBaseCommit}）构建，已包含官方 v${input.officialVersion} 全部改动`
    ]
    if (input.upstreamCommitsBehind > 0) {
      reasons.push(`当前基线还领先官方发布标签 ${input.upstreamCommitsBehind} 个上游提交`)
    }
    if (isForkVersion) {
      reasons.push(`本地采用独立版本号 v${input.currentVersion}，与官方版本号不直接按大小对比`)
    }
    return {
      hasNewerThanBase: false,
      level: 'up-to-date',
      canDirectMerge: true,
      summary: `当前代码已包含官方 v${input.officialVersion}，无需合并（本地版本 v${input.currentVersion}）。`,
      reasons,
      upstreamCommitsAhead: 0,
      upstreamCommitsBehind: input.upstreamCommitsBehind,
      forkCommitsAhead: input.forkCommitsAhead,
      forkChangedFiles: input.forkChangedFiles,
      upstreamChangedFiles: [],
      overlapFiles: [],
      forkOnlyIsolatedChanges,
      upstreamCoreOrDependencyChanged: false
    }
  }

  const pkgFlags = input.packageChanges ?? {
    electronMajorChanged: false,
    dependenciesChanged: false
  }
  const upstreamCoreOrDependencyChanged =
    pkgFlags.electronMajorChanged ||
    pkgFlags.dependenciesChanged ||
    input.upstreamChangedFiles.some((file) =>
      CORE_HOST_PATHS.some((prefix) => file.startsWith(prefix))
    )

  // package.json 若仅有版本号改动（双方各自发版），不视为代码冲突。
  const excludePackageJson = !pkgFlags.electronMajorChanged && !pkgFlags.dependenciesChanged
  const forkComparable = input.forkChangedFiles.filter(
    (file) => !excludePackageJson || file !== 'package.json'
  )
  const upstreamSet = new Set(
    input.upstreamChangedFiles.filter((file) => !excludePackageJson || file !== 'package.json')
  )
  const overlapFiles = forkComparable.filter((file) => upstreamSet.has(file))

  if (!input.compareSucceeded) {
    const baseMajor = extractMajorVersion(upstreamBaseVersion)
    const officialMajor = extractMajorVersion(input.officialVersion)
    const isMajorBump = baseMajor !== null && officialMajor !== null && officialMajor > baseMajor
    const level: MergeImpactLevel = isMajorBump ? 'high' : 'medium'
    return {
      hasNewerThanBase: true,
      level,
      canDirectMerge: false,
      summary: isMajorBump
        ? `官方已发布跨主版本 v${input.officialVersion}，且当前无法拉取文件差异，建议自行对比后再决定是否合并。`
        : `官方已发布新版本 v${input.officialVersion}（相对基线 v${upstreamBaseVersion}），暂时无法获取文件对比明细，建议手动确认影响后合并。`,
      reasons: [
        `官方版本：v${input.officialVersion}（相对基线 v${upstreamBaseVersion}）`,
        '未能连接 GitHub Compare 接口获取精确文件交集'
      ],
      upstreamCommitsAhead: input.upstreamCommitsAhead,
      upstreamCommitsBehind: input.upstreamCommitsBehind,
      forkCommitsAhead: input.forkCommitsAhead,
      forkChangedFiles: input.forkChangedFiles,
      upstreamChangedFiles: input.upstreamChangedFiles,
      overlapFiles: [],
      forkOnlyIsolatedChanges,
      upstreamCoreOrDependencyChanged: isMajorBump
    }
  }

  if (overlapFiles.length > 0 || pkgFlags.electronMajorChanged) {
    const reasons: string[] = [
      `官方领先当前基线 ${input.upstreamCommitsAhead} 个提交，改动 ${input.upstreamChangedFiles.length} 个文件`
    ]
    if (overlapFiles.length > 0) {
      reasons.push(`存在 ${overlapFiles.length} 个与您仓库重叠修改的文件（可能产生合并冲突）`)
    }
    if (pkgFlags.electronMajorChanged) {
      reasons.push('官方升级了 Electron 主版本，可能影响原生模块与窗口兼容行为')
    }
    return {
      hasNewerThanBase: true,
      level: 'high',
      canDirectMerge: false,
      summary: `官方 v${input.officialVersion} 影响较大（${overlapFiles.length} 个重叠文件${pkgFlags.electronMajorChanged ? '且含 Electron 主版本变更' : ''}），建议自行对比后再决定合并或继续使用我的源。`,
      reasons,
      upstreamCommitsAhead: input.upstreamCommitsAhead,
      upstreamCommitsBehind: input.upstreamCommitsBehind,
      forkCommitsAhead: input.forkCommitsAhead,
      forkChangedFiles: input.forkChangedFiles,
      upstreamChangedFiles: input.upstreamChangedFiles,
      overlapFiles,
      forkOnlyIsolatedChanges,
      upstreamCoreOrDependencyChanged
    }
  }

  if (
    upstreamCoreOrDependencyChanged ||
    (!forkOnlyIsolatedChanges && input.upstreamChangedFiles.length > 25)
  ) {
    const reasons: string[] = [
      `官方领先当前基线 ${input.upstreamCommitsAhead} 个提交，改动 ${input.upstreamChangedFiles.length} 个文件`,
      '与您的仓库修改无直接文件冲突'
    ]
    if (pkgFlags.dependenciesChanged) {
      reasons.push('官方更新了运行依赖（dependencies），建议确认插件兼容性')
    }
    if (!pkgFlags.dependenciesChanged && upstreamCoreOrDependencyChanged) {
      reasons.push('官方调整了宿主核心调度或 preload/存储模块，建议评估后再合并')
    }
    return {
      hasNewerThanBase: true,
      level: 'medium',
      canDirectMerge: false,
      summary: `官方 v${input.officialVersion} 与您的修改无直接冲突，但涉及核心模块或依赖调整，建议评估后决定是否合并。`,
      reasons,
      upstreamCommitsAhead: input.upstreamCommitsAhead,
      upstreamCommitsBehind: input.upstreamCommitsBehind,
      forkCommitsAhead: input.forkCommitsAhead,
      forkChangedFiles: input.forkChangedFiles,
      upstreamChangedFiles: input.upstreamChangedFiles,
      overlapFiles: [],
      forkOnlyIsolatedChanges,
      upstreamCoreOrDependencyChanged
    }
  }

  const reasons: string[] = [
    `官方领先当前基线 ${input.upstreamCommitsAhead} 个提交，改动 ${input.upstreamChangedFiles.length} 个文件`,
    '与您的本地修改零文件交集，且未改动 Electron 或底层核心依赖'
  ]
  if (forkOnlyIsolatedChanges) {
    reasons.push('您的仓库仅包含独立插件/测试等隔离改动，可直接安全合并')
  }
  return {
    hasNewerThanBase: true,
    level: 'low',
    canDirectMerge: true,
    summary: `官方 v${input.officialVersion} 与您的修改无冲突且影响极小，可直接合并官方更新。`,
    reasons,
    upstreamCommitsAhead: input.upstreamCommitsAhead,
    upstreamCommitsBehind: input.upstreamCommitsBehind,
    forkCommitsAhead: input.forkCommitsAhead,
    forkChangedFiles: input.forkChangedFiles,
    upstreamChangedFiles: input.upstreamChangedFiles,
    overlapFiles: [],
    forkOnlyIsolatedChanges,
    upstreamCoreOrDependencyChanged: false
  }
}

/**
 * 合并“我的源”和“官方源”的下载渠道列表，使更新窗口可以在多源之间自由切换。
 * @param options 我的源版本信息与官方源平台更新信息。
 * @returns 去重且携带各自版本、日志及归属标识的候选下载源列表。
 */
export function buildMergedUpdateSources(options: {
  myRelease: RepoLatestReleaseInfo
  officialPlatformInfo: PlatformUpdateInfo | null
  officialRelease: RepoLatestReleaseInfo | null
}): UpdateDownloadSource[] {
  const sources: UpdateDownloadSource[] = []

  if (options.myRelease.latestVersion) {
    sources.push({
      id: MY_UPDATE_SOURCE_ID,
      platformName: `我的源 (${FORK_OWNER}/${FORK_REPO})`,
      downloadUrl: options.myRelease.assetUrl || options.myRelease.releaseUrl,
      isDirect: true,
      feedUrl: getForkReleaseFeedUrl(options.myRelease.latestVersion),
      origin: 'mine',
      version: options.myRelease.latestVersion,
      changelog: options.myRelease.changelog || `### 我的源 v${options.myRelease.latestVersion}`,
      releaseUrl: options.myRelease.releaseUrl
    })
  }

  const officialVersion =
    options.officialPlatformInfo?.version ?? options.officialRelease?.latestVersion ?? undefined
  const officialChangelog =
    options.officialPlatformInfo?.changelog ?? options.officialRelease?.changelog ?? ''
  const officialReleaseUrl =
    options.officialPlatformInfo?.releaseUrl ??
    options.officialRelease?.releaseUrl ??
    GITHUB_LATEST_RELEASE_URL

  if (options.officialPlatformInfo?.sources?.length) {
    for (const source of options.officialPlatformInfo.sources) {
      sources.push({
        ...source,
        origin: 'official',
        version: source.version ?? officialVersion,
        changelog: source.changelog ?? officialChangelog,
        releaseUrl: source.releaseUrl ?? officialReleaseUrl
      })
    }
  } else if (officialVersion) {
    sources.push({
      id: 1,
      platformName: `GitHub (官方 ${UPSTREAM_OWNER})`,
      downloadUrl: options.officialRelease?.assetUrl || officialReleaseUrl,
      isDirect: false,
      origin: 'official',
      version: officialVersion,
      changelog: officialChangelog,
      releaseUrl: officialReleaseUrl
    })
  }

  return sources
}

/**
 * 执行一次完整的双源更新检查与上游合并影响分析。
 * @param preferredOrigin 用户当前的默认更新源偏好。
 * @param includePrerelease 是否包含预发布（Beta）版本。
 * @returns 双源版本结果、合并影响分析及整合后的可切换下载源列表。
 */
export async function checkForkAndOfficialUpdates(
  preferredOrigin: UpdateOrigin = 'mine',
  includePrerelease = false
): Promise<CombinedUpdateCheckResult> {
  const currentVersion = app.getVersion()

  // 并行请求“我的源”和“官方源”，缩短检查等待时间。
  const [myRelease, officialServerResult, officialGithubFallback] = await Promise.all([
    fetchGitHubRepoLatestRelease(FORK_OWNER, FORK_REPO, includePrerelease),
    fetchLatestServerUpdate().catch((error: unknown) => {
      console.warn('[Updater] 请求官方更新服务失败，尝试使用 GitHub Release 回退:', error)
      return null
    }),
    fetchGitHubRepoLatestRelease(UPSTREAM_OWNER, UPSTREAM_REPO, includePrerelease)
  ])

  const officialVersion =
    officialServerResult?.latestVersion ?? officialGithubFallback.latestVersion ?? null
  const officialChangelog =
    officialServerResult?.releaseNotes ?? officialGithubFallback.changelog ?? ''

  let officialPlatformInfo: PlatformUpdateInfo | null = null
  if (officialServerResult?.available) {
    try {
      officialPlatformInfo = await resolvePlatformUpdateInfo(officialServerResult)
    } catch (error) {
      console.warn('[Updater] 解析官方下载源列表失败:', error)
    }
  }

  // 并行拉取 fork 自身修改清单和官方目标标签相对基线的修改清单。
  const forkComparePromise = safeHttpGet(
    `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${FORK_UPSTREAM_BASE.commit}...${FORK_OWNER}:main`,
    GITHUB_API_HEADERS
  )

  let upstreamCompare: GitHubCompareResponse | null = null
  let resolvedUpstreamRef = officialVersion ? `v${officialVersion}` : `${UPSTREAM_OWNER}:main`
  if (officialVersion) {
    const tagPayload = await safeHttpGet(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${FORK_UPSTREAM_BASE.commit}...${encodeURIComponent(resolvedUpstreamRef)}`,
      GITHUB_API_HEADERS
    )
    if (tagPayload && typeof tagPayload === 'object' && 'status' in tagPayload) {
      upstreamCompare = tagPayload as GitHubCompareResponse
    } else {
      resolvedUpstreamRef = `${UPSTREAM_OWNER}:main`
      const mainPayload = await safeHttpGet(
        `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${FORK_UPSTREAM_BASE.commit}...${UPSTREAM_OWNER}:main`,
        GITHUB_API_HEADERS
      )
      if (mainPayload && typeof mainPayload === 'object' && 'status' in mainPayload) {
        upstreamCompare = mainPayload as GitHubCompareResponse
      }
    }
  }

  const forkComparePayload = (await forkComparePromise) as GitHubCompareResponse | null
  const forkChangedFiles = Array.isArray(forkComparePayload?.files)
    ? forkComparePayload.files
        .map((f) => f.filename)
        .filter((name): name is string => typeof name === 'string')
    : []
  const upstreamChangedFiles = Array.isArray(upstreamCompare?.files)
    ? upstreamCompare.files
        .map((f) => f.filename)
        .filter((name): name is string => typeof name === 'string')
    : []

  const packageChanges =
    upstreamCompare &&
    (upstreamCompare.ahead_by ?? 0) > 0 &&
    upstreamChangedFiles.includes('package.json')
      ? await inspectUpstreamPackageChanges(resolvedUpstreamRef)
      : { electronMajorChanged: false, dependenciesChanged: false }

  const impact = evaluateMergeImpact({
    currentVersion,
    officialVersion,
    upstreamBaseVersion: FORK_UPSTREAM_BASE.version,
    upstreamBaseCommit: FORK_UPSTREAM_BASE.commit,
    forkCommitsAhead: forkComparePayload?.ahead_by ?? 0,
    upstreamCommitsAhead: upstreamCompare?.ahead_by ?? 0,
    upstreamCommitsBehind: upstreamCompare?.behind_by ?? 0,
    forkChangedFiles,
    upstreamChangedFiles,
    packageChanges,
    compareSucceeded: Boolean(upstreamCompare && typeof upstreamCompare.status === 'string')
  })

  const myHasUpdate = Boolean(
    myRelease.latestVersion && compareSemverVersions(myRelease.latestVersion, currentVersion) > 0
  )
  const officialHasNewerThanLocal = Boolean(
    officialVersion && compareSemverVersions(officialVersion, currentVersion) > 0
  )

  const analysis: ForkUpdateAnalysis = {
    currentVersion,
    upstreamBaseVersion: FORK_UPSTREAM_BASE.version,
    upstreamBaseCommit: FORK_UPSTREAM_BASE.commit,
    mySource: {
      repo: myRelease.repo,
      latestVersion: myRelease.latestVersion,
      hasUpdate: myHasUpdate,
      releaseUrl: myRelease.releaseUrl,
      changelog: myRelease.changelog,
      publishedAt: myRelease.publishedAt,
      error: myRelease.error
    },
    officialSource: {
      repo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`,
      latestVersion: officialVersion,
      hasNewerThanBase: impact.hasNewerThanBase,
      hasNewerThanLocal: officialHasNewerThanLocal,
      releaseUrl:
        officialPlatformInfo?.releaseUrl ||
        (officialVersion ? getGitHubReleaseUrl(officialVersion) : GITHUB_LATEST_RELEASE_URL),
      changelog: officialChangelog,
      publishedAt: officialServerResult?.publishedAt ?? officialGithubFallback.publishedAt,
      error: !officialVersion ? officialGithubFallback.error : undefined
    },
    mergeImpact: {
      level: impact.level,
      canDirectMerge: impact.canDirectMerge,
      summary: impact.summary,
      reasons: impact.reasons,
      upstreamCommitsAhead: impact.upstreamCommitsAhead,
      upstreamCommitsBehind: impact.upstreamCommitsBehind,
      forkCommitsAhead: impact.forkCommitsAhead,
      forkChangedFiles: impact.forkChangedFiles,
      upstreamChangedFiles: impact.upstreamChangedFiles,
      overlapFiles: impact.overlapFiles,
      forkOnlyIsolatedChanges: impact.forkOnlyIsolatedChanges,
      upstreamCoreOrDependencyChanged: impact.upstreamCoreOrDependencyChanged
    },
    checkedAt: Date.now()
  }

  const mergedSources = buildMergedUpdateSources({
    myRelease,
    officialPlatformInfo,
    officialRelease: officialGithubFallback
  })

  const defaultUseMine = preferredOrigin === 'mine' && (myHasUpdate || !impact.hasNewerThanBase)
  if (officialPlatformInfo) {
    officialPlatformInfo = {
      ...officialPlatformInfo,
      preferredOrigin: defaultUseMine ? 'mine' : preferredOrigin,
      forkAnalysis: analysis,
      sources: mergedSources
    }
  }

  return {
    analysis,
    myRelease,
    officialServerUpdate: officialServerResult,
    officialPlatformInfo,
    mergedSources
  }
}
