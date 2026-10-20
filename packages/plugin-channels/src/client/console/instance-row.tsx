/**
 * One row of the channel-instance list: state dot, name, platform type, tenant,
 * the runtime explanation, and the row's own controls (credential state, the
 * enable switch, select-for-bindings, edit, delete).
 *
 * The row is selectable, so selection lives on a real button that spans the
 * row's text area rather than on the container: the trailing controls stay
 * ordinary siblings, never nested inside another interactive element. The same
 * select action is repeated as an explicit icon button, so "manage this
 * instance's bindings" is a visible affordance and not only a row click. Hover
 * is tracked in React because the bundle ships no stylesheet and an inline
 * style cannot express `:hover`.
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconEditOutlineRegular,
  IconLinkOutlineRegular,
  IconTrashOutlineRegular,
  StateDot,
  Switch,
  Tag,
  Tooltip,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelInstanceView, InstanceRuntime } from '../api.ts'
import { fmt, type Translate } from '../locales.ts'
import { colors, styles } from './ui.ts'

/** Runtime state → the dot's own vocabulary (a spinner means work in flight). */
const DOT_STATES: Readonly<Record<InstanceRuntime['state'], StateDotState>> = {
  disabled: 'idle',
  pending: 'ongoing',
  connected: 'done',
  failed: 'error',
}

const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }

/** The second line: what the runtime is actually doing right now. */
function RuntimeLine({ t, instance }: { t: Translate; instance: ChannelInstanceView }): ReactElement {
  const runtime = instance.runtime
  if (runtime.state === 'connected') {
    return (
      <span>{runtime.identity?.username === undefined
        ? t('channels.badge.connected')
        : `@${runtime.identity.username}`}</span>
    )
  }
  if (runtime.state === 'failed') {
    return (
      <span style={{ ...styles.row, minWidth: 0 }}>
        <Tag tone="danger">{t('channels.badge.failed')}</Tag>
        {/* A raw adapter error can be a whole sentence: cap it, keep it on one
            line, and leave the full text on the native title. */}
        <span
          title={runtime.error}
          style={{
            color: colors.danger,
            fontFamily: colors.code,
            maxWidth: 420,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {runtime.error}
        </span>
      </span>
    )
  }
  return <span>{t(runtime.state === 'pending' ? 'channels.badge.pending' : 'channels.badge.disabled')}</span>
}

export interface InstanceRowProps {
  t: Translate
  instance: ChannelInstanceView
  selected: boolean
  /** Draw the row's top hairline (every row but the first). */
  divided: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
}

export function InstanceRow({
  t,
  instance,
  selected,
  divided,
  onSelect,
  onEdit,
  onDelete,
  onToggle,
}: InstanceRowProps): ReactElement {
  const [hovered, setHovered] = useState(false)
  const actionLabel = (action: string): string => fmt(t('channels.action.aria'), { action, name: instance.name })

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        borderTop: divided ? `1px solid ${colors.border}` : undefined,
        background: selected || hovered ? colors.hover : undefined,
        outline: selected ? `2px solid ${colors.accent}` : undefined,
        outlineOffset: selected ? -2 : undefined,
      }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={fmt(t('channels.select.aria'), { name: instance.name })}
        onClick={onSelect}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <StateDot state={DOT_STATES[instance.runtime.state]} />
        <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 600, ...ELLIPSIS }}>{instance.name}</span>
            <Tag tone="outline">{instance.channelType}</Tag>
            {instance.targetName !== undefined && (
              <Tag tone="info">
                {t(`channels.target.kind.${instance.target.kind}`)} · {instance.targetName}
              </Tag>
            )}
            <Tag tone="quiet">{instance.tenant}</Tag>
          </span>
          <span style={{ fontSize: 12, lineHeight: '18px', color: colors.secondary, ...ELLIPSIS }}>
            <RuntimeLine t={t} instance={instance} />
          </span>
        </span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', padding: '12px 14px 12px 0' }}>
        <Tag tone={instance.credential.configured ? 'success' : 'warning'}>
          {t(instance.credential.configured ? 'channels.credential.configured' : 'channels.credential.missing')}
        </Tag>
        {instance.tokenRef !== undefined && <Tag tone="info">{t('channels.credential.fromEnv')}</Tag>}
        <Tooltip label={t('channels.switch.title')}>
          <span style={{ display: 'inline-flex' }}>
            <Switch
              checked={instance.enabled}
              onChange={onToggle}
              label={fmt(t('channels.switch.aria'), { name: instance.name })}
            />
          </span>
        </Tooltip>
        <Tooltip label={t('channels.action.bind')}>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconLinkOutlineRegular size={16} />}
            aria-label={actionLabel(t('channels.action.bind'))}
            aria-pressed={selected}
            onClick={onSelect}
          />
        </Tooltip>
        <Tooltip label={t('channels.action.edit')}>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconEditOutlineRegular size={16} />}
            aria-label={actionLabel(t('channels.action.edit'))}
            onClick={onEdit}
          />
        </Tooltip>
        <Tooltip label={t('channels.action.delete')}>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconTrashOutlineRegular size={16} />}
            style={styles.danger}
            aria-label={actionLabel(t('channels.action.delete'))}
            onClick={onDelete}
          />
        </Tooltip>
      </div>
    </div>
  )
}
