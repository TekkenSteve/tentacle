// @vitest-environment jsdom
/**
 * The restricted-UI views shadowed over the stock client for normal users:
 * RestrictedWorkspacesView lists ONLY the user's fenced cwd bucket;
 * RestrictedSettingsView renders nothing at all.
 */
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RestrictedSettingsView,
  RestrictedWorkspacesView,
  rowVisibleFor,
  type SessionsHook,
} from '../../src/client/restricted.tsx'
import { zh, type TentacleLocaleKey } from '../../src/client/locales.ts'

const t = (key: TentacleLocaleKey): string => zh[key]

interface Row {
  id: string
  displayTitle: string
  title?: string
  cwd?: string
  running?: boolean
  blank?: boolean
  origin?: 'subagent'
}

/** A useSessions-style selector hook over a fixed feed. */
function sessionsHook(rows: Row[]): SessionsHook {
  const state = {
    ids: rows.map((r) => r.id),
    byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  }
  return <T,>(selector: (s: typeof state) => T): T => selector(state)
}

const FEED: Row[] = [
  { id: 's1', displayTitle: 'mine one', cwd: '/ws/alice' },
  { id: 's2', displayTitle: 'mine two', title: 'Durable title', cwd: '/ws/alice', running: true },
  { id: 's3', displayTitle: 'foreign', cwd: '/ws/bob' },
  { id: 's4', displayTitle: 'operator session', cwd: '/home/operator' },
  { id: 's5', displayTitle: 'subagent row', cwd: '/ws/alice', origin: 'subagent' },
  { id: 's6', displayTitle: 'blank row', cwd: '/ws/alice', blank: true },
]

function renderBrowser(workspaceRootDir: string | undefined, feed: Row[] = FEED) {
  const openSession = vi.fn()
  render(
    <RestrictedWorkspacesView
      t={t}
      wide={true}
      useSessions={sessionsHook(feed)}
      openSession={openSession}
      workspaceRootDir={workspaceRootDir}
      handle="alice"
    />,
  )
  return { openSession }
}

afterEach(cleanup)

describe('RestrictedWorkspacesView', () => {
  it('lists only sessions cwd-bucketed into the user workspace', () => {
    renderBrowser('/ws/alice')
    expect(screen.getByText('mine one')).toBeTruthy()
    expect(screen.getByText('Durable title')).toBeTruthy() // durable title wins over displayTitle
    expect(screen.queryByText('foreign')).toBeNull()
    expect(screen.queryByText('operator session')).toBeNull()
    expect(screen.queryByText('subagent row')).toBeNull()
    expect(screen.queryByText('blank row')).toBeNull()
  })

  it('fails open to the full feed when the user holds no fence', () => {
    renderBrowser(undefined)
    expect(screen.getByText('mine one')).toBeTruthy()
    expect(screen.getByText('foreign')).toBeTruthy()
    expect(screen.getByText('operator session')).toBeTruthy()
    // subagent/blank rows stay hidden even without a fence
    expect(screen.queryByText('subagent row')).toBeNull()
  })

  it('opens a session on row click', () => {
    const { openSession } = renderBrowser('/ws/alice')
    fireEvent.click(screen.getByText('mine one'))
    expect(openSession).toHaveBeenCalledWith('s1')
  })

  it('shows the empty note when no session matches', () => {
    renderBrowser('/ws/alice', [{ id: 's9', displayTitle: 'foreign', cwd: '/ws/bob' }])
    expect(screen.getByText(zh['browser.empty'])).toBeTruthy()
  })
})

describe('rowVisibleFor', () => {
  it('encodes the bucketing rule', () => {
    expect(rowVisibleFor({ id: 'a', displayTitle: 'x', cwd: '/ws/alice' }, '/ws/alice')).toBe(true)
    expect(rowVisibleFor({ id: 'b', displayTitle: 'x', cwd: '/ws/bob' }, '/ws/alice')).toBe(false)
    expect(rowVisibleFor({ id: 'c', displayTitle: 'x' }, '/ws/alice')).toBe(false)
    expect(rowVisibleFor({ id: 'd', displayTitle: 'x', cwd: '/ws/alice', origin: 'subagent' }, '/ws/alice')).toBe(false)
    expect(rowVisibleFor({ id: 'e', displayTitle: 'x', cwd: '/ws/alice', blank: true }, '/ws/alice')).toBe(false)
    expect(rowVisibleFor({ id: 'f', displayTitle: 'x', cwd: '/ws/bob' }, undefined)).toBe(true)
  })
})

describe('RestrictedSettingsView', () => {
  it('renders nothing — the settings entry point disappears', () => {
    const { container } = render(<RestrictedSettingsView />)
    expect(container.innerHTML).toBe('')
  })
})
