/* eslint-disable @typescript-eslint/explicit-function-return-type -- classic plugin scripts use JSDoc return types. */

/**
 * 将辅助函数限制在私有作用域后发布给时间戳插件页面。
 * @returns {void} 无返回值。
 */
;(function createTimestampTime() {
  /**
   * 将毫秒时间戳转换为 datetime-local 输入框使用的本地时间。
   * @param {number} timestamp 毫秒时间戳。
   * @returns {string} 本地日期时间输入值；无效时间返回空字符串。
   */
  function toLocalInput(timestamp) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return ''

    const local = new Date(timestamp - date.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 19)
  }

  /**
   * 将 datetime-local 的本地日期时间转换为毫秒时间戳。
   * @param {string} value datetime-local 输入值。
   * @returns {number | null} 有效时返回毫秒时间戳，否则返回 null。
   */
  function fromLocalInput(value) {
    if (!value) return null
    const timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }

  /**
   * 将日期时间字段补齐为两位显示。
   * @param {number} part 日期时间中的数值字段。
   * @returns {string} 两位数字文本。
   */
  function padTimePart(part) {
    return String(part).padStart(2, '0')
  }

  /**
   * 解析秒或毫秒格式的 Unix 时间戳。
   * @param {string} value 用户输入的时间戳。
   * @returns {number | null} 归一化后的毫秒时间戳；输入无效或超出日期范围时返回 null。
   */
  function parseTimestamp(value) {
    const normalized = value.trim()
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null

    const numericValue = Number(normalized)
    const timestamp = Math.abs(numericValue) >= 100_000_000_000 ? numericValue : numericValue * 1000
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null
    return timestamp
  }

  /**
   * 将毫秒时间戳格式化为本地日期时间。
   * @param {number} timestamp 毫秒时间戳。
   * @returns {string} YYYY-MM-DD HH:mm:ss 格式的本地时间；无效时间返回空字符串。
   */
  function formatLocalDateTime(timestamp) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return ''

    return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}:${padTimePart(date.getSeconds())}`
  }

  /**
   * 将毫秒时间戳格式化为 UTC ISO 日期时间。
   * @param {number} timestamp 毫秒时间戳。
   * @returns {string} UTC ISO 日期时间；无效时间返回空字符串。
   */
  function formatUtcDateTime(timestamp) {
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }

  /**
   * 将带符号的毫秒差值格式化为天、时、分、秒。
   * @param {number} milliseconds 带符号的时间差。
   * @returns {string} 可读的时长。
   */
  function formatDuration(milliseconds) {
    const sign = milliseconds < 0 ? '−' : '+'
    let remaining = Math.floor(Math.abs(milliseconds) / 1000)
    const days = Math.floor(remaining / 86_400)
    remaining %= 86_400
    const hours = Math.floor(remaining / 3600)
    remaining %= 3600
    const minutes = Math.floor(remaining / 60)
    const seconds = remaining % 60
    const dayLabel = days ? `${days}天 ` : ''

    return `${sign}${dayLabel}${padTimePart(hours)}:${padTimePart(minutes)}:${padTimePart(seconds)}`
  }

  /**
   * 根据天、时、分、秒字段计算时长毫秒数。
   * @param {number[]} parts 按天、时、分、秒排列的非负数字。
   * @returns {number} 合计时长毫秒数。
   */
  function durationToMilliseconds(parts) {
    const [days = 0, hours = 0, minutes = 0, seconds = 0] = parts
    return (
      Math.max(0, days) * 86_400_000 +
      Math.max(0, hours) * 3_600_000 +
      Math.max(0, minutes) * 60_000 +
      Math.max(0, seconds) * 1000
    )
  }

  window.TimestampTime = Object.freeze({
    toLocalInput,
    fromLocalInput,
    parseTimestamp,
    formatLocalDateTime,
    formatUtcDateTime,
    formatDuration,
    durationToMilliseconds
  })
})()
