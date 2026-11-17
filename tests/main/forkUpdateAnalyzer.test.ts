import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  fetchLatestServerUpdate: vi.fn(),
  resolvePlatformUpdateInfo: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.1'),
    isPackaged: true
  }
}))

vi.mock('../../src/main/utils/httpRequest', () => ({
  httpRequest: mocks.httpRequest
}))

vi.mock('../../src/main/api/serverUpdateCatalog', () => ({
  fetchLatestServerUpdate: mocks.fetchLatestServerUpdate,
  resolvePlatformUpdateInfo: mocks.resolvePlatformUpdateInfo
}))

import { app } from 'electron'
import {
  buildMergedUpdateSources,
  checkForkAndOfficialUpdates,
  evaluateMergeImpact
} from '../../src/main/api/forkUpdateAnalyzer'
import {
  compareSemverVersions,
  FORK_OWNER,
  FORK_REPO,
  FORK_UPSTREAM_BASE,
  getDefaultUpdateSourceID,
  getForkReleaseFeedUrl,
  MY_UPDATE_SOURCE_ID,
  UPSTREAM_OWNER,
  UPSTREAM_REPO
} from '../../src/shared/updateSource'

describe('forkUpdateAnalyzer 与多源选择', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(app.getVersion).mockReturnValue('0.0.1')
  })

  it('compareSemverVersions 应正确比较常规版本与预发布版本大小', () => {
    expect(compareSemverVersions('0.0.2', '0.0.1')).toBeGreaterThan(0)
    expect(compareSemverVersions('0.0.1', '0.0.1')).toBe(0)
    expect(compareSemverVersions('3.2.0', '3.1.9')).toBeGreaterThan(0)
    expect(compareSemverVersions('3.2.0-beta.1', '3.2.0')).toBeLessThan(0)
    expect(compareSemverVersions('3.2.0-beta.2', '3.2.0-beta.1')).toBeGreaterThan(0)
  })

  it('getDefaultUpdateSourceID 应按偏好优先返回我的源或官方源', () => {
    const sources = [
      {
        id: 1,
        platformName: '官方源',
        isDirect: true,
        feedUrl: 'https://official.example/feed',
        origin: 'official' as const
      },
      {
        id: MY_UPDATE_SOURCE_ID,
        platformName: '我的源',
        isDirect: true,
        feedUrl: 'https://mine.example/feed',
        origin: 'mine' as const
      }
    ]

    expect(getDefaultUpdateSourceID(sources, 'mine')).toBe(MY_UPDATE_SOURCE_ID)
    expect(getDefaultUpdateSourceID(sources, 'official')).toBe(1)
  })

  it('本地 0.0.1 且基线 a4d0459 已包含官方 v3.2.0 时不应误报官方新版本', () => {
    const impact = evaluateMergeImpact({
      currentVersion: '0.0.1',
      officialVersion: '3.2.0',
      upstreamBaseVersion: FORK_UPSTREAM_BASE.version,
      upstreamBaseCommit: FORK_UPSTREAM_BASE.commit,
      forkCommitsAhead: 2,
      upstreamCommitsAhead: 0,
      upstreamCommitsBehind: 47,
      forkChangedFiles: ['internal-plugins/demo/index.ts'],
      upstreamChangedFiles: [],
      compareSucceeded: true
    })

    expect(impact.hasNewerThanBase).toBe(false)
    expect(impact.level).toBe('up-to-date')
    expect(impact.canDirectMerge).toBe(true)

    const offlineImpact = evaluateMergeImpact({
      currentVersion: '0.0.1',
      officialVersion: '3.2.0',
      forkCommitsAhead: 0,
      upstreamCommitsAhead: 0,
      upstreamCommitsBehind: 0,
      forkChangedFiles: [],
      upstreamChangedFiles: [],
      compareSucceeded: false
    })
    expect(offlineImpact.hasNewerThanBase).toBe(false)
    expect(offlineImpact.level).toBe('up-to-date')
  })

  it('fork 仅改动独立小插件且与官方新版本零冲突时应判定可直接合并（low）', () => {
    const impact = evaluateMergeImpact({
      currentVersion: '0.0.1',
      officialVersion: '3.3.0',
      forkCommitsAhead: 1,
      upstreamCommitsAhead: 12,
      upstreamCommitsBehind: 0,
      forkChangedFiles: ['internal-plugins/my-widget/index.ts', 'tests/main/myWidget.test.ts'],
      upstreamChangedFiles: ['src/renderer/src/components/search/SearchBox.vue'],
      packageChanges: { electronMajorChanged: false, dependenciesChanged: false },
      compareSucceeded: true
    })

    expect(impact.hasNewerThanBase).toBe(true)
    expect(impact.level).toBe('low')
    expect(impact.canDirectMerge).toBe(true)
    expect(impact.forkOnlyIsolatedChanges).toBe(true)
    expect(impact.overlapFiles).toEqual([])
  })

  it('存在重叠修改文件或 Electron 主版本升级时应判定影响较大（high）', () => {
    const overlapImpact = evaluateMergeImpact({
      currentVersion: '0.0.1',
      officialVersion: '3.3.0',
      forkCommitsAhead: 3,
      upstreamCommitsAhead: 8,
      upstreamCommitsBehind: 0,
      forkChangedFiles: ['src/main/api/updater.ts'],
      upstreamChangedFiles: ['src/main/api/updater.ts', 'README.md'],
      compareSucceeded: true
    })

    expect(overlapImpact.hasNewerThanBase).toBe(true)
    expect(overlapImpact.level).toBe('high')
    expect(overlapImpact.canDirectMerge).toBe(false)
    expect(overlapImpact.overlapFiles).toEqual(['src/main/api/updater.ts'])

    const coreImpact = evaluateMergeImpact({
      currentVersion: '0.0.1',
      officialVersion: '3.3.0',
      forkCommitsAhead: 1,
      upstreamCommitsAhead: 5,
      upstreamCommitsBehind: 0,
      forkChangedFiles: ['internal-plugins/my-widget/index.ts'],
      upstreamChangedFiles: ['src/main/index.ts'],
      packageChanges: { electronMajorChanged: false, dependenciesChanged: true },
      compareSucceeded: true
    })

    expect(coreImpact.hasNewerThanBase).toBe(true)
    expect(coreImpact.level).toBe('medium')
    expect(coreImpact.canDirectMerge).toBe(false)
  })

  it('buildMergedUpdateSources 与 checkForkAndOfficialUpdates 应整合我的源与官方源结果', async () => {
    const forkLatest = {
      repo: `${FORK_OWNER}/${FORK_REPO}`,
      latestVersion: '0.0.2',
      changelog: '我的插件增强',
      releaseUrl: `https://github.com/${FORK_OWNER}/${FORK_REPO}/releases/tag/v0.0.2`,
      assetUrl: `https://github.com/${FORK_OWNER}/${FORK_REPO}/releases/download/v0.0.2/ZTools-0.0.2-setup.exe`
    }

    const merged = buildMergedUpdateSources({
      myRelease: forkLatest,
      officialPlatformInfo: {
        version: '3.3.0',
        changelog: '官方更新',
        sources: [
          {
            id: 10,
            platformName: '官方源',
            downloadUrl: 'https://official.example/setup.exe',
            isDirect: true,
            feedUrl: 'https://official.example/feed'
          }
        ]
      },
      officialRelease: null
    })

    expect(merged.map((s) => s.id)).toEqual([MY_UPDATE_SOURCE_ID, 10])
    expect(merged[0]).toMatchObject({
      origin: 'mine',
      version: '0.0.2',
      feedUrl: getForkReleaseFeedUrl('0.0.2')
    })
    expect(merged[1]).toMatchObject({
      origin: 'official',
      version: '3.3.0'
    })

    mocks.fetchLatestServerUpdate.mockResolvedValue({
      available: true,
      latestVersion: '3.3.0',
      releaseNotes: '上游新版本',
      publishedAt: 1794900000000
    })
    mocks.resolvePlatformUpdateInfo.mockResolvedValue({
      version: '3.3.0',
      changelog: '上游新版本',
      releaseUrl: `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/tag/v3.3.0`,
      sources: [
        {
          id: 1,
          platformName: '官方源',
          downloadUrl: 'https://official.example/3.3.0.exe',
          isDirect: true,
          feedUrl: 'https://official.example/feed'
        }
      ]
    })

    mocks.httpRequest.mockImplementation(async (url: string) => {
      if (url.includes(`/repos/${FORK_OWNER}/${FORK_REPO}/releases/latest`)) {
        return {
          data: {
            tag_name: 'v0.0.2',
            body: '我的新版本',
            html_url: forkLatest.releaseUrl,
            published_at: '2026-11-17T08:00:00Z',
            assets: [
              {
                name: 'ZTools-0.0.2-win-x64-setup.exe',
                browser_download_url: forkLatest.assetUrl
              }
            ]
          },
          status: 200,
          statusMessage: 'OK',
          headers: {}
        }
      }
      if (url.includes(`/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/latest`)) {
        return {
          data: {
            tag_name: 'v3.3.0',
            body: '官方更新内容',
            html_url: `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/tag/v3.3.0`,
            assets: []
          },
          status: 200,
          statusMessage: 'OK',
          headers: {}
        }
      }
      if (url.includes(`/compare/${FORK_UPSTREAM_BASE.commit}...${FORK_OWNER}:main`)) {
        return {
          data: {
            status: 'ahead',
            ahead_by: 1,
            behind_by: 0,
            files: [{ filename: 'internal-plugins/my-widget/index.ts' }]
          },
          status: 200,
          statusMessage: 'OK',
          headers: {}
        }
      }
      if (url.includes(`/compare/${FORK_UPSTREAM_BASE.commit}...v3.3.0`)) {
        return {
          data: {
            status: 'ahead',
            ahead_by: 5,
            behind_by: 0,
            files: [{ filename: 'README.md' }]
          },
          status: 200,
          statusMessage: 'OK',
          headers: {}
        }
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const combined = await checkForkAndOfficialUpdates('mine', false)
    expect(combined.analysis.mySource.hasUpdate).toBe(true)
    expect(combined.analysis.officialSource.hasNewerThanBase).toBe(true)
    expect(combined.analysis.mergeImpact.level).toBe('low')
    expect(combined.analysis.mergeImpact.canDirectMerge).toBe(true)
    expect(combined.mergedSources.some((s) => s.id === MY_UPDATE_SOURCE_ID)).toBe(true)
    expect(combined.mergedSources.some((s) => s.origin === 'official')).toBe(true)
  })
})
