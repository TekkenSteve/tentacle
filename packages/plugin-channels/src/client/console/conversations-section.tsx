/**
 * The read-only conversation block: which channel conversation is fenced onto
 * which DSH session, for the selected instance.
 *
 * Every cell is a machine identifier. They are rendered monospace on one line
 * and ellipsized inside a fixed column, so a long generated session id can
 * never stretch the table past the panel; the full value stays on the native
 * hover title.
 */
import type { ReactElement } from 'react'
import type { ConversationView } from '../api.ts'
import type { Translate } from '../locales.ts'
import { styles } from './ui.ts'

export interface ConversationsSectionProps {
  t: Translate
  conversations: readonly ConversationView[]
}

/** Fixed column shares; with `table-layout: fixed` these drive the ellipsis. */
const COLUMN_WIDTHS = ['22%', '33%', '45%'] as const

export function ConversationsSection({ t, conversations }: ConversationsSectionProps): ReactElement {
  if (conversations.length === 0) return <p style={styles.hint}>{t('channels.hint.noConversations')}</p>
  return (
    <div style={styles.card}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={{ ...styles.th, width: COLUMN_WIDTHS[0] }}>{t('channels.col.channelId')}</th>
            <th style={{ ...styles.th, width: COLUMN_WIDTHS[1] }}>{t('channels.col.conversation')}</th>
            <th style={{ ...styles.th, width: COLUMN_WIDTHS[2] }}>{t('channels.col.session')}</th>
          </tr>
        </thead>
        <tbody>
          {conversations.map((row) => (
            <tr key={`${row.channelId}/${row.conversation}`}>
              <td style={{ ...styles.td, ...styles.codeCell }} title={row.channelId}>{row.channelId}</td>
              <td style={{ ...styles.td, ...styles.codeCell }} title={row.conversation}>{row.conversation}</td>
              <td style={{ ...styles.td, ...styles.codeCell }} title={row.sessionId}>{row.sessionId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
