/**
 * One bundled template card (design 09 §3, the reference implementation's "built-in expert" grid).
 *
 * Templates are read-only package assets: the card shows what the template
 * ships (bilingual identity, welcome message, seed file count via prompt
 * hints) and offers the one write action that makes sense — clone it into a
 * new expert instance.
 */
import type { ReactElement } from 'react'
import { Button, IconAgentPresetOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { fmt, type Translate } from '../locales.ts'
import { text, type TemplateRow } from './api.ts'
import { accentOf, colors, styles } from './ui.ts'

export interface TemplateCardProps {
  t: Translate
  template: TemplateRow
  onCopy: () => void
}

export function TemplateCard({ t, template, onCopy }: TemplateCardProps): ReactElement {
  const accent = accentOf(template.id, template.color)
  const welcome = template.welcomeMessage === undefined ? '' : text(template.welcomeMessage)

  return (
    <div style={styles.card} role="group" aria-label={text(template.label)}>
      <span style={styles.accentBar(accent)} />
      <div style={styles.cardHeader}>
        <div style={styles.iconTile(accent)}>
          {template.icon ?? <IconAgentPresetOutlineRegular size={20} />}
        </div>
        <div style={styles.cardTitleBlock}>
          <div style={styles.cardNameRow}>
            <span style={styles.cardName}>{text(template.label)}</span>
            {template.installedExpertId !== undefined && <Tag tone="success">{t('experts.badge.installed')}</Tag>}
          </div>
          <span style={{ ...styles.tiny, fontFamily: colors.code }}>{template.id}</span>
          <span style={{ ...styles.tiny, fontFamily: colors.code, color: colors.tertiary }} title={t('experts.library.presetHint')}>
            {template.agentPresetId}
          </span>
        </div>
      </div>

      <p style={styles.cardDesc} title={text(template.description)}>{text(template.description)}</p>

      {welcome !== '' && (
        <p style={{ ...styles.cardDesc, color: colors.tertiary, minHeight: 0 }} title={welcome}>{welcome}</p>
      )}

      <div style={styles.cardFooter}>
        <span style={styles.tiny}>
          {template.quickPrompts.length > 0
            ? fmt(t('experts.library.quickPrompts'), { n: String(template.quickPrompts.length) })
            : ''}
        </span>
        <Button size="sm" variant="outline" onClick={onCopy} title={t('experts.library.copyHint')}>
          {t('experts.action.createCopy')}
        </Button>
      </div>
    </div>
  )
}
