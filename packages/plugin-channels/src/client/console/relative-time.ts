/**
 * Relative-time copy for the bindings table.
 *
 * The bucketing is the official `relativeTime` from the UI primitives, so this
 * page and every other dated surface agree on when "2 hours" becomes "3"; only
 * the words live in this plugin's dictionary.
 */
import { relativeTime, type RelativeTimeUnit } from '@deepseek-ai/dsh-client-ui-primitives'
import { fmt, type ChannelsLocaleKey, type Translate } from '../locales.ts'

const UNIT_KEYS: Readonly<Record<RelativeTimeUnit, ChannelsLocaleKey>> = {
  now: 'channels.time.now',
  minutes: 'channels.time.minutes',
  hours: 'channels.time.hours',
  days: 'channels.time.days',
  months: 'channels.time.months',
  years: 'channels.time.years',
}

/**
 * Humanize a dated moment against `now` (injected so renderers stay pure).
 * @param t - the console's locale resolver.
 * @param at - epoch ms of the dated moment.
 * @param now - current epoch ms; defaults to the wall clock.
 */
export function relativeLabel(t: Translate, at: number, now: number = Date.now()): string {
  const { unit, n } = relativeTime(at, now)
  const template = t(UNIT_KEYS[unit])
  return unit === 'now' ? template : fmt(template, { n })
}
