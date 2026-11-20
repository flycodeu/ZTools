/* eslint-disable @typescript-eslint/explicit-function-return-type -- classic plugin scripts use JSDoc return types. */

const {
  durationToMilliseconds,
  formatDuration,
  formatLocalDateTime,
  formatUtcDateTime,
  fromLocalInput,
  parseTimestamp,
  toLocalInput
} = window.TimestampTime

let toastTimer

/**
 * 按页面 ID 获取时间工具控件。
 * @param {string} id 页面元素 ID。
 * @returns {HTMLElement} 匹配的页面元素。
 * @throws {Error} 页面缺少指定元素时抛出错误。
 */
function getElement(id) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`时间戳插件缺少页面元素：${id}`)
  return element
}

/**
 * 刷新当前本地时间及秒、毫秒时间戳。
 * @returns {void} 无返回值。
 */
function updateClock() {
  const now = Date.now()
  getElement('current-date').textContent = formatLocalDateTime(now)
  getElement('current-seconds').textContent = String(Math.floor(now / 1000))
  getElement('current-milliseconds').textContent = String(now)
}

/**
 * 根据所选本地日期更新时间戳输出。
 * @returns {void} 无返回值。
 */
function updateDateConversion() {
  const timestamp = fromLocalInput(getElement('date-input').value)
  const seconds = getElement('date-result-seconds')
  const milliseconds = getElement('date-result-milliseconds')
  seconds.textContent = timestamp === null ? '—' : String(Math.floor(timestamp / 1000))
  milliseconds.textContent = timestamp === null ? '—' : String(timestamp)
}

/**
 * 将用户输入的秒或毫秒时间戳转换为本地时间与 UTC 时间。
 * @returns {void} 无返回值。
 */
function updateTimestampConversion() {
  const timestamp = parseTimestamp(getElement('timestamp-input').value)
  const localDate = getElement('timestamp-result-date')
  const utcDate = getElement('timestamp-result-utc')

  if (timestamp === null) {
    localDate.textContent = '输入秒或毫秒时间戳'
    utcDate.textContent = ''
    localDate.dataset.copyValue = ''
    utcDate.dataset.copyValue = ''
    for (const button of document.querySelectorAll('.date-copy-actions button')) {
      button.disabled = true
    }
    return
  }

  localDate.textContent = formatLocalDateTime(timestamp)
  utcDate.textContent = `UTC ${formatUtcDateTime(timestamp)}`
  localDate.dataset.copyValue = localDate.textContent
  utcDate.dataset.copyValue = utcDate.textContent
  for (const button of document.querySelectorAll('.date-copy-actions button')) {
    button.disabled = false
  }
}

/**
 * 计算两个日期之间的有符号时长。
 * @returns {void} 无返回值。
 */
function updateDifference() {
  const start = fromLocalInput(getElement('difference-start').value)
  const end = fromLocalInput(getElement('difference-end').value)
  const human = getElement('difference-human')
  const total = getElement('difference-total')

  if (start === null || end === null) {
    human.textContent = '选择开始和结束时间'
    total.textContent = ''
    return
  }

  const difference = end - start
  human.textContent = formatDuration(difference)
  total.textContent = `${difference.toLocaleString()} 毫秒 · ${(difference / 1000).toLocaleString()} 秒`
}

/**
 * 对基准日期加上或减去指定时长，并更新结果时间戳。
 * @returns {void} 无返回值。
 */
function updateArithmetic() {
  const base = fromLocalInput(getElement('arithmetic-date').value)
  const result = getElement('arithmetic-result')
  const timestamp = getElement('arithmetic-timestamp')

  if (base === null) {
    result.textContent = '选择基准时间'
    timestamp.textContent = ''
    return
  }

  const duration = durationToMilliseconds([
    Number(getElement('duration-days').value),
    Number(getElement('duration-hours').value),
    Number(getElement('duration-minutes').value),
    Number(getElement('duration-seconds').value)
  ])
  const sign = getElement('duration-operation').value === 'subtract' ? -1 : 1
  const calculated = base + duration * sign
  result.textContent = formatLocalDateTime(calculated)
  timestamp.textContent = String(calculated)
}

/**
 * 切换转换和计算两个工具页面。
 * @param {string} tabName 要显示的页面名称。
 * @returns {void} 无返回值。
 */
function selectTab(tabName) {
  const isConvert = tabName === 'convert'
  getElement('convert-panel').hidden = !isConvert
  getElement('calculate-panel').hidden = isConvert
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === tabName
    tab.classList.toggle('is-active', active)
    tab.setAttribute('aria-current', active ? 'page' : 'false')
  }
}

/**
 * 响应工具页签点击。
 * @param {MouseEvent} event 页签点击事件。
 * @returns {void} 无返回值。
 */
function handleTabClick(event) {
  const target = event.target instanceof Element ? event.target.closest('.tab') : null
  if (target instanceof HTMLElement && target.dataset.tab) selectTab(target.dataset.tab)
}

/**
 * 显示复制操作的短暂结果提示。
 * @param {string} message 提示内容。
 * @returns {void} 无返回值。
 */
function showToast(message) {
  const toast = getElement('toast')
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(hideToast, 1400)
}

/**
 * 自动隐藏复制反馈提示。
 * @returns {void} 无返回值。
 */
function hideToast() {
  getElement('toast').classList.remove('is-visible')
}

/**
 * 复制指定结果，并向用户显示操作状态。
 * @param {MouseEvent} event 复制按钮点击事件。
 * @returns {Promise<void>} 复制尝试结束后完成的 Promise。
 */
async function handleCopyClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-copy-target]') : null
  if (!(target instanceof HTMLElement)) return

  const output = getElement(target.dataset.copyTarget || '')
  const text = output.dataset.copyValue ?? output.textContent?.trim() ?? ''
  if (!text || text === '—') {
    showToast('没有可复制的内容')
    return
  }

  try {
    if (window.ztools?.copyText) {
      if (!window.ztools.copyText(text)) throw new Error('复制失败')
    } else {
      await navigator.clipboard.writeText(text)
    }
    showToast('已复制')
  } catch {
    showToast('复制失败')
  }
}

/**
 * 使用当前时间初始化日期控件并连接所有时间计算交互。
 * @returns {void} 无返回值。
 */
function initialize() {
  const now = Date.now()
  const inputValue = toLocalInput(now)
  getElement('date-input').value = inputValue
  getElement('difference-start').value = inputValue
  getElement('difference-end').value = inputValue
  getElement('arithmetic-date').value = inputValue
  getElement('local-timezone').textContent = `· ${Intl.DateTimeFormat().resolvedOptions().timeZone}`

  updateClock()
  updateDateConversion()
  updateDifference()
  updateArithmetic()
  setInterval(updateClock, 1000)

  getElement('date-input').addEventListener('input', updateDateConversion)
  getElement('timestamp-input').addEventListener('input', updateTimestampConversion)
  getElement('difference-start').addEventListener('input', updateDifference)
  getElement('difference-end').addEventListener('input', updateDifference)
  getElement('arithmetic-date').addEventListener('input', updateArithmetic)
  getElement('duration-operation').addEventListener('change', updateArithmetic)
  for (const input of document.querySelectorAll('.duration-fields input')) {
    input.addEventListener('input', updateArithmetic)
  }
  document.querySelector('.tabs')?.addEventListener('click', handleTabClick)
  document.addEventListener('click', handleCopyClick)
}

initialize()
