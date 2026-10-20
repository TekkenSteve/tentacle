/**
 * Restricted-UI seats shadowed over the stock Web Client for normal users
 * (research §1.7 — the official shadowing semantics: a single-kind cell
 * renders the LOWEST priority entry, so a lower-priority registration
 * shadows the stock entry and disposing it restores stock):
 *
 *  - `sidebar.workspaces` → RestrictedWorkspacesView: only the sessions
 *    whose cwd is the user's fenced workspace root (mirroring the gateway's
 *    session.create fence at the display layer). Subagent rows and blank
 *    placeholders stay hidden.
 *  - `sidebar.settings`   → RestrictedSettingsView: renders nothing — the
 *    settings trigger disappears (normal users must not reach the global
 *    settings panel; the gateway policy already denies the RPC surface,
 *    this is the anti-misclick layer).
 *
 * These views are pure: every framework input (sessions feed, navigation)
 * arrives as a prop so tests never mount the client runtime.
 */
import type { ReactElement } from 'react'
import type { TentacleLocaleKey } from './locales.ts'

/** Translate function for the tentacle namespace. */
export type Translate = (key: TentacleLocaleKey) => string

/** The subset of SessionSummary the browser reads. */
interface SessionRow {
  id: string
  displayTitle: string
  /** Durable log-backed title, present once the host projects one. */
  title?: string
  cwd?: string
  running?: boolean
  blank?: boolean
  origin?: 'subagent'
}

/** The subset of SessionListState the browser reads. */
interface SessionsState {
  ids: readonly string[]
  byId: Record<string, SessionRow | undefined>
}

/** A useSessions-style selector hook (injected for tests). */
export type SessionsHook = <T>(selector: (state: SessionsState) => T) => T

/** Props of the sidebar.workspaces shadow. */
export interface RestrictedWorkspacesViewProps {
  t: Translate
  /** Wide sidebar vs the collapsed rail. */
  wide: boolean
  /** The framework's global sessions feed (standard kit). */
  useSessions: SessionsHook
  /** Open one of the listed sessions. */
  openSession: (sessionId: string) => void;
  /**
   * The caller's workspace fence (from /tentacle/api/me). When undefined the
   * user holds no fence — display fails open to the unfiltered feed rather
   * than hiding every session behind a shadow the policy never asked for.
   */
  workspaceRootDir: string | undefined
  /** Signed-in user's handle, shown as the section caption. */
  handle: string
}

/**
 * Decide whether a feed row belongs in the restricted browser. Exported for
 * the tests of the bucketing rule itself.
 */
export function rowVisibleFor(row: SessionRow, workspaceRootDir: string | undefined): boolean {
  if (row.origin === 'subagent' || row.blank === true) return false
  if (workspaceRootDir === undefined) return true
  return row.cwd === workspaceRootDir
}

/** The session browser: only this user's cwd-bucketed sessions. */
export function RestrictedWorkspacesView(props: RestrictedWorkspacesViewProps): ReactElement {
  const list = props.useSessions((s) => s)
  const rows = list.ids
    .map((id) => list.byId[id])
    .filter((row): row is SessionRow => row !== undefined)
    .filter((row) => rowVisibleFor(row, props.workspaceRootDir))
  return (
    <div data-wide={props.wide ? 'true' : undefined} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '4px 12px', fontSize: 12, opacity: 0.7 }}>
        <span>{props.t('browser.section')}</span>
        <span style={{ marginLeft: 6, fontWeight: 600 }}>{props.handle}</span>
      </div>
      {rows.length === 0 ? (
        <p style={{ padding: '4px 12px', fontSize: 12, opacity: 0.6 }}>{props.t('browser.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto' }}>
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => props.openSession(row.id)}
              >
                {row.running ? <span aria-hidden="true" style={{ marginRight: 6 }}>●</span> : null}
                <span>{row.title ?? row.displayTitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Renders nothing — the settings trigger vanishes for normal users. */
export function RestrictedSettingsView(): ReactElement | null {
  return null
}
