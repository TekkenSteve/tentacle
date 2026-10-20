/**
 * One expert card — a compact management surface modelled on the DSH Agency
 * Agents card: fixed-height card with avatar, identity/division line, a
 * three-line description, fact chips and a full-width action bar.
 *
 * The card itself opens the detail drawer; the footer keeps the primary
 * actions one click away (edit / channels / detail / delete) without nesting
 * interactive elements inside the card's own button.
 */
import type { ReactElement } from 'react'
import {
  IconEditOutlineRegular,
  IconLinkOutlineRegular,
  IconPaperPlaneOutlineRegular,
  IconTrashOutlineRegular,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import { text, type ExpertRow } from './api.ts'
import { accentOf, colors, styles } from './ui.ts'

export interface ExpertCardProps {
  t: Translate
  expert: ExpertRow
  /** Number of channel instances routed to this expert (0 when unknown). */
  channelCount: number
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
  /** Open the channels console scoped to this expert. */
  onChannels: () => void
}

const clamp = (lines: number) => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical' as const,
  WebkitLineClamp: lines,
  overflow: 'hidden',
})

export function ExpertCard({ t, expert, channelCount, onOpen, onEdit, onDelete, onChannels }: ExpertCardProps): ReactElement {
  const accent = accentOf(expert.id, expert.color)

  return (
    <div
      style={styles.expertCard}
      role="button"
      tabIndex={0}
      aria-label={`${text(expert.name)} — ${t('experts.action.detail')}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <span style={{ ...styles.accentBar(accent), height: 3 }} />
      <div style={styles.cardBody}>
        <div style={styles.cardHeaderNew}>
          <div style={{ ...styles.avatar, background: `${accent}1f`, border: `1px solid ${accent}44` }}>
            {expert.icon ?? text(expert.name).slice(0, 1)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ ...styles.cardName, fontSize: 15, lineHeight: '22px', ...clamp(1) }} title={text(expert.name)}>
                {text(expert.name)}
              </span>
              {expert.default && <Tag tone="solid">{t('experts.badge.default')}</Tag>}
              {expert.builtin
                ? <Tag tone="neutral">{t('experts.badge.builtin')}</Tag>
                : <Tag tone="outline">{t('experts.badge.custom')}</Tag>}
            </div>
            <div style={styles.division}>
              <span style={styles.divisionPill}>{t('experts.card.template')}: {expert.templateId ?? t('experts.card.custom')}</span>
              <span style={{ ...styles.divisionPill, fontFamily: colors.code, fontSize: 10 }} title={t('experts.card.presetHint')}>
                {expert.agentPreset}
              </span>
            </div>
          </div>
        </div>

        <p style={{ ...styles.cardDesc, margin: '10px 0 0', ...clamp(3), minHeight: 0 }} title={text(expert.description)}>
          {text(expert.description)}
        </p>

        <div style={{ ...styles.row, gap: 6, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 10 }}>
          <span style={styles.divisionPill}>
            {t('experts.card.model')}: {expert.model === undefined ? t('experts.card.deploymentDefault') : `${expert.model.provider}/${expert.model.model}`}
          </span>
          <span style={styles.divisionPill}>
            {t('experts.card.permission')}: {expert.permissionPreset ?? t('experts.card.deploymentDefault')}
          </span>
          <span style={styles.divisionPill}>{t('experts.card.skills')} {expert.skills}</span>
          <span style={styles.divisionPill}>{t('experts.card.channels')} {channelCount}</span>
        </div>
      </div>

      <div style={styles.cardActionsBar}>
        <button
          type="button"
          style={styles.cardAction}
          onClick={(event) => { event.stopPropagation(); onEdit() }}
        >
          <IconEditOutlineRegular size={14} />{t('experts.action.edit')}
        </button>
        <button
          type="button"
          style={styles.cardAction}
          onClick={(event) => { event.stopPropagation(); onChannels() }}
        >
          <IconPaperPlaneOutlineRegular size={14} />{t('experts.action.channels')}
        </button>
        <button
          type="button"
          style={styles.cardAction}
          onClick={(event) => { event.stopPropagation(); onOpen() }}
        >
          <IconLinkOutlineRegular size={14} />{t('experts.action.detail')}
        </button>
        {!expert.builtin && (
          <button
            type="button"
            style={{ ...styles.cardAction, color: colors.danger }}
            onClick={(event) => { event.stopPropagation(); onDelete() }}
          >
            <IconTrashOutlineRegular size={14} />{t('experts.action.delete')}
          </button>
        )}
      </div>
    </div>
  )
}
