/**
 * Table view for the expert panel (the reference implementation's card/table toggle's table half).
 * Cards are the primary browse surface; the table is for operators scanning
 * routing facts across many experts.
 */
import type { ReactElement } from 'react'
import { Button, IconEditOutlineRegular, IconLinkOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import { text, type ExpertRow } from './api.ts'
import { colors, styles } from './ui.ts'

export interface ExpertsTableProps {
  t: Translate
  experts: readonly ExpertRow[]
  channelCountOf: (expertId: string) => number
  onOpen: (expert: ExpertRow) => void
  onEdit: (expert: ExpertRow) => void
}

export function ExpertsTable({ t, experts, channelCountOf, onOpen, onEdit }: ExpertsTableProps): ReactElement {
  return (
    <div style={styles.tableCard}>
      <table style={styles.table}>
        <colgroup>
          <col style={{ width: '26%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '22%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: 92 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={styles.th}>{t('experts.col.name')}</th>
            <th style={styles.th}>{t('experts.card.id')}</th>
            <th style={styles.th}>{t('experts.card.preset')}</th>
            <th style={styles.th}>{t('experts.card.model')}</th>
            <th style={styles.th}>{t('experts.card.permission')}</th>
            <th style={styles.th}>{t('experts.card.skills')}</th>
            <th style={styles.th}>{t('experts.card.channels')}</th>
            <th style={{ ...styles.th, textAlign: 'right' }} />
          </tr>
        </thead>
        <tbody>
          {experts.map((expert) => (
            <tr key={expert.id}>
              <td style={styles.td}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span aria-hidden="true">{expert.icon ?? text(expert.name).slice(0, 1)}</span>
                  {text(expert.name)}
                  {expert.default && <Tag tone="solid">{t('experts.badge.default')}</Tag>}
                  {expert.builtin
                    ? <Tag tone="neutral">{t('experts.badge.builtin')}</Tag>
                    : <Tag tone="outline">{t('experts.badge.custom')}</Tag>}
                </span>
              </td>
              <td style={{ ...styles.td, fontFamily: colors.code, fontSize: 11 }}>{expert.id}</td>
              <td style={{ ...styles.td, fontFamily: colors.code, fontSize: 11 }}>{expert.agentPreset}</td>
              <td style={styles.td}>
                {expert.model === undefined
                  ? t('experts.card.deploymentDefault')
                  : `${expert.model.provider}/${expert.model.model}`}
              </td>
              <td style={styles.td}>{expert.permissionPreset ?? t('experts.card.deploymentDefault')}</td>
              <td style={styles.td}>{expert.skills}</td>
              <td style={styles.td}>{channelCountOf(expert.id)}</td>
              <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <Button
                  size="sm"
                  variant="toolbar"
                  aria-label={t('experts.action.detail')}
                  icon={<IconLinkOutlineRegular size={14} />}
                  onClick={() => onOpen(expert)}
                />
                <Button
                  size="sm"
                  variant="toolbar"
                  aria-label={t('experts.action.edit')}
                  icon={<IconEditOutlineRegular size={14} />}
                  onClick={() => onEdit(expert)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
