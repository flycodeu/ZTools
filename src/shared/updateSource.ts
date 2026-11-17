export const GITHUB_REPOSITORY_URL = 'https://github.com/ZToolsCenter/ZTools'
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`

export const UPSTREAM_OWNER = 'ZToolsCenter'
export const UPSTREAM_REPO = 'ZTools'

export const FORK_OWNER = 'flycodeu'
export const FORK_REPO = 'ZTools'
export const FORK_GITHUB_REPOSITORY_URL = `https://github.com/${FORK_OWNER}/${FORK_REPO}`
export const FORK_GITHUB_RELEASES_URL = `${FORK_GITHUB_REPOSITORY_URL}/releases`
export const FORK_GITHUB_LATEST_RELEASE_URL = `${FORK_GITHUB_RELEASES_URL}/latest`

/**
 * 当前 fork 仓库所基于的上游官方基线信息，用于过滤旧版本误报并计算合并影响。
 */
export const FORK_UPSTREAM_BASE = {
  version: '3.2.0',
  commit: 'a4d0459',
  repo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`
} as const

/** 我的源在多下载渠道列表中的固定标识（负值，避免与服务端自增 ID 冲突）。 */
export const MY_UPDATE_SOURCE_ID = -100

/** 更新源归属类型：我的源或官方源。 */
export type UpdateOrigin = 'mine' | 'official'

/** 合并官方新版本时的影响等级。 */
export type MergeImpactLevel = 'up-to-date' | 'low' | 'medium' | 'high' | 'unknown'

/** 设备级应用更新偏好设置（保存在 settings-general 中）。 */
export interface UpdatePreferences {
  preferredUpdateSource: UpdateOrigin
  ignoreOfficialUpdateNotice: boolean
}

/** 官方新版本与当前 fork 仓库之间的差距及合并影响分析结果。 */
export interface ForkUpdateAnalysis {
  currentVersion: string
  upstreamBaseVersion: string
  upstreamBaseCommit: string
  mySource: {
    repo: string
    latestVersion: string | null
    hasUpdate: boolean
    releaseUrl: string
    changelog: string
    publishedAt?: number
    error?: string
  }
  officialSource: {
    repo: string
    latestVersion: string | null
    hasNewerThanBase: boolean
    hasNewerThanLocal: boolean
    releaseUrl: string
    changelog: string
    publishedAt?: number
    error?: string
  }
  mergeImpact: {
    level: MergeImpactLevel
    canDirectMerge: boolean
    summary: string
    reasons: string[]
    upstreamCommitsAhead: number
    upstreamCommitsBehind: number
    forkCommitsAhead: number
    forkChangedFiles: string[]
    upstreamChangedFiles: string[]
    overlapFiles: string[]
    forkOnlyIsolatedChanges: boolean
    upstreamCoreOrDependencyChanged: boolean
  }
  checkedAt: number
}

export interface SelectableUpdateSource {
  id: number
  platformName: string
  isDirect: boolean
  feedUrl?: string
  origin?: UpdateOrigin
  version?: string
  changelog?: string
  releaseUrl?: string
}

/**
 * 判断下载源是否支持由应用内更新器直接下载和安装。
 * @param source 服务端返回的候选下载源。
 * @returns 同时标记为直链且提供更新 feed 时返回 true。
 */
export function isInAppUpdateSource(source: SelectableUpdateSource): boolean {
  return source.isDirect && Boolean(source.feedUrl)
}

/**
 * 从下载源列表中选择默认渠道，可按偏好优先选择我的源或官方源。
 * @param sources 当前版本可用的下载源列表。
 * @param preferredOrigin 用户偏好的更新源归属；未传时保持原有官方源优先逻辑。
 * @returns 默认下载源标识；没有可用来源时返回 null。
 */
export function getDefaultUpdateSourceID(
  sources: SelectableUpdateSource[],
  preferredOrigin?: UpdateOrigin
): number | null {
  const mySource = sources.find(
    (source) => source.origin === 'mine' || source.id === MY_UPDATE_SOURCE_ID
  )
  const officialSource = sources.find((source) => source.platformName.trim() === '官方源')
  const githubSource = sources.find(
    (source) => source.platformName.trim().toLowerCase() === 'github'
  )

  if (preferredOrigin === 'mine' && mySource) {
    return mySource.id
  }
  return officialSource?.id ?? githubSource?.id ?? mySource?.id ?? sources[0]?.id ?? null
}

/**
 * 生成指定版本的 GitHub Release 页面地址。
 * @param version 目标版本号，不包含前导 v；为空时返回最新正式版页面。
 * @returns GitHub Release 页面地址。
 */
export function getGitHubReleaseUrl(version?: string): string {
  if (!version) return GITHUB_LATEST_RELEASE_URL
  return `${GITHUB_RELEASES_URL}/tag/v${encodeURIComponent(version)}`
}

/**
 * 生成我的源（flycodeu/ZTools）指定版本的 GitHub Release 页面地址。
 * @param version 目标版本号，不包含前导 v；为空时返回最新正式版页面。
 * @returns 我的源 GitHub Release 页面地址。
 */
export function getForkGitHubReleaseUrl(version?: string): string {
  if (!version) return FORK_GITHUB_LATEST_RELEASE_URL
  return `${FORK_GITHUB_RELEASES_URL}/tag/v${encodeURIComponent(version)}`
}

/**
 * 生成我的源（flycodeu/ZTools）指定版本供 electron-updater 读取的通用 feed 地址。
 * @param version 目标版本号，不包含前导 v。
 * @returns GitHub Release 资产下载基地址。
 */
export function getForkReleaseFeedUrl(version: string): string {
  const cleanVersion = version.trim().replace(/^v/i, '')
  return `${FORK_GITHUB_RELEASES_URL}/download/v${encodeURIComponent(cleanVersion)}`
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: Array<number | string>
}

/**
 * 解析包含可选前缀 v 与预发布后缀的语义化版本号。
 * @param rawVersion 原始版本字符串。
 * @returns 解析后的版本结构；格式不合法时返回 null。
 */
function parseSemver(rawVersion: string): ParsedSemver | null {
  const cleaned = rawVersion.trim().replace(/^v/i, '').split('+')[0]
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null

  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : []

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

/**
 * 比较两个语义化版本号的大小（遵循 SemVer 2.0 预发布规则）。
 * @param a 左侧版本号。
 * @param b 右侧版本号。
 * @returns a > b 返回 1，a < b 返回 -1，相等或无法比较返回 0。
 */
export function compareSemverVersions(a: string, b: string): number {
  const parsedA = parseSemver(a)
  const parsedB = parseSemver(b)
  if (!parsedA || !parsedB) return a.localeCompare(b)

  if (parsedA.major !== parsedB.major) return parsedA.major > parsedB.major ? 1 : -1
  if (parsedA.minor !== parsedB.minor) return parsedA.minor > parsedB.minor ? 1 : -1
  if (parsedA.patch !== parsedB.patch) return parsedA.patch > parsedB.patch ? 1 : -1

  // 无预发布标签的正式版高于同主次修订号的预发布版。
  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length === 0) return 0
  if (parsedA.prerelease.length === 0) return 1
  if (parsedB.prerelease.length === 0) return -1

  const maxLen = Math.max(parsedA.prerelease.length, parsedB.prerelease.length)
  for (let i = 0; i < maxLen; i++) {
    const partA = parsedA.prerelease[i]
    const partB = parsedB.prerelease[i]
    if (partA === undefined) return -1
    if (partB === undefined) return 1
    if (partA === partB) continue

    const isNumA = typeof partA === 'number'
    const isNumB = typeof partB === 'number'
    if (isNumA && isNumB) return partA > partB ? 1 : -1
    if (isNumA !== isNumB) return isNumA ? -1 : 1
    return String(partA) > String(partB) ? 1 : -1
  }

  return 0
}
