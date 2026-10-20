/**
 * The team card — the roster at a glance: icon, name, member stack with
 * pinned expert ids, the contract one-liner and the workspace footer.
 */
import type { ReactElement } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import { text, type TeamRow } from './api.ts'
import { accentOf, colors, styles } from './ui.ts'

/** Initials for the member stack chip (expert ids are lowercase slugs). */
function initials(expertId: string): string {
  const parts = expertId.split(/[-_]/).filter((part) => part !== '')
  const letters = parts.slice(0, 2).map((part) => part[0]!.toUpperCase())
  return letters.join('') || expertId.slice(0, 2).toUpperCase()
}

export function TeamCard({ team, t, onOpen }: {
  team: TeamRow
  t: Translate
  onOpen: (team: TeamRow) => void
}): ReactElement {
  const accent = accentOf(team.id, team.color)
  return (
    <div
      style={styles.teamCard}
      role="button"
      tabIndex={0}
      title={t('teams.card.openHint')}
      onClick={() => onOpen(team)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(team)
        }
      }}
    >
      <div style={styles.cardBody}>
        <div style={styles.cardHeader}>
          <div style={{ ...styles.avatar, background: `${accent}1f`, color: accent }}>
            {team.icon ?? '👥'}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {text(team.name)}
              </span>
              {team.builtin
                ? <Tag tone="neutral">{t('teams.badge.builtin')}</Tag>
                : <Tag tone="outline">{t('teams.badge.custom')}</Tag>}
            </div>
            <div style={{ ...styles.division, color: colors.secondary }}>
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {text(team.description)}
              </span>
            </div>
          </div>
        </div>

        <div style={{ ...styles.division, marginTop: 10 }}>
          <div style={styles.avatarStack}>
            {team.members.slice(0, 5).map((member, index) => (
              <div
                key={member.expertId}
                style={{ ...styles.avatarStackItem, ...(index === 0 ? styles.avatarStackFirst : {}), borderColor: colors.layer1 }}
                title={`${member.expertName} · ${text(member.role)}`}
              >
                {initials(member.expertId)}
              </div>
            ))}
            {team.members.length > 5 ? (
              <div style={{ ...styles.avatarStackItem, borderColor: colors.layer1 }}>+{team.members.length - 5}</div>
            ) : null}
          </div>
          <span style={{ fontSize: 11, color: colors.tertiary }}>
            {t('teams.members.count').replace('{n}', String(team.members.length))}
          </span>
          <span style={styles.divisionPill}>
            {team.collaboration === 'auto' ? t('teams.badge.auto') : t('teams.badge.dispatch')}
          </span>
        </div>

        <div style={{ ...styles.division, marginTop: 8, fontSize: 11, color: colors.tertiary }}>
          <span style={{ ...styles.mono, color: colors.tertiary }}>{team.presetId}</span>
        </div>
      </div>
      <div style={styles.cardFooter}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={team.workspacePath}>
          {team.workspacePath}
        </span>
        {team.templateId !== undefined ? <span style={styles.divisionPill}>{team.templateId}</span> : null}
      </div>
    </div>
  )
}
