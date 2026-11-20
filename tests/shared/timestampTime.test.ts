import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const timeScript = readFileSync(
  path.join(process.cwd(), 'internal-plugins', 'timestamp', 'public', 'time.js'),
  'utf8'
)
const time = runInNewContext(`${timeScript}\nwindow.TimestampTime`, { window: {} }) as {
  durationToMilliseconds: (parts: number[]) => number
  formatDuration: (milliseconds: number) => string
  formatUtcDateTime: (timestamp: number) => string
  fromLocalInput: (value: string) => number | null
  parseTimestamp: (value: string) => number | null
  toLocalInput: (timestamp: number) => string
}

describe('timestamp time conversion', () => {
  it('recognizes Unix timestamps in seconds and milliseconds', () => {
    expect(time.parseTimestamp('1700000000')).toBe(1_700_000_000_000)
    expect(time.parseTimestamp('1700000000000')).toBe(1_700_000_000_000)
    expect(time.parseTimestamp('-1')).toBe(-1000)
  })

  it('rejects empty, non-numeric, and out-of-range timestamps', () => {
    expect(time.parseTimestamp('')).toBeNull()
    expect(time.parseTimestamp('2026-11-20')).toBeNull()
    expect(time.parseTimestamp('999999999999999999999999')).toBeNull()
  })

  it('round-trips local date inputs and formats UTC output', () => {
    const source = 1_700_000_000_000
    expect(time.fromLocalInput(time.toLocalInput(source))).toBe(source)
    expect(time.formatUtcDateTime(source)).toBe('2023-11-14T22:13:20.000Z')
  })

  it('formats signed date differences and totals day-hour fields', () => {
    expect(time.formatDuration(90_061_000)).toBe('+1天 01:01:01')
    expect(time.formatDuration(-61_000)).toBe('−00:01:01')
    expect(time.durationToMilliseconds([1, 2, 3, 4])).toBe(93_784_000)
  })
})
