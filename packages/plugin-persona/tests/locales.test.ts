import { describe, expect, it } from 'vitest'
import { zh, en } from '../src/client/locales.js'

// The locale runtime enforces bilingual balance at registration; pin it here
// so a forgotten key fails before the bundle ever ships.
describe('persona client locales', () => {
  it('zh and en dictionaries are key-identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
