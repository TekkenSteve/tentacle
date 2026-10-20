// @vitest-environment jsdom
/**
 * `relativeLabel` is the only piece of the bindings table that turns the
 * official time bucket into words; the words themselves are dictionary copy,
 * checked here against fixed instants so a locale edit cannot silently change
 * the bucket boundaries.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-stub.tsx'))

import { relativeLabel } from '../../src/client/console/relative-time.ts'
import { fmt, zh, type ChannelsLocaleKey } from '../../src/client/locales.ts'

const t = (key: ChannelsLocaleKey): string => zh[key]
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('binding time copy', () => {
  it('walks every relative bucket the primitives define', () => {
    expect(relativeLabel(t, NOW - 30_000, NOW)).toBe(zh['channels.time.now'])
    expect(relativeLabel(t, NOW - 5 * MINUTE, NOW)).toBe(fmt(zh['channels.time.minutes'], { n: 5 }))
    expect(relativeLabel(t, NOW - 2 * HOUR, NOW)).toBe(fmt(zh['channels.time.hours'], { n: 2 }))
    expect(relativeLabel(t, NOW - 3 * DAY, NOW)).toBe(fmt(zh['channels.time.days'], { n: 3 }))
    expect(relativeLabel(t, NOW - 40 * DAY, NOW)).toBe(fmt(zh['channels.time.months'], { n: 1 }))
    expect(relativeLabel(t, NOW - 800 * DAY, NOW)).toBe(fmt(zh['channels.time.years'], { n: 2 }))
  })

  it('never reports a future instant as negative time', () => {
    expect(relativeLabel(t, NOW + 5 * MINUTE, NOW)).toBe(zh['channels.time.now'])
  })
})
