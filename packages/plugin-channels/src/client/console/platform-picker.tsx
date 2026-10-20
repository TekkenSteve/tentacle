/**
 * The "add a channel" catalog — one card per platform the host advertises.
 *
 * Modelled on DSH IM Connect's platform catalog: the operator picks a platform
 * first, then the schema-driven account form opens for that type. This keeps
 * the form focused on one platform instead of forcing a type select inside it.
 */
import type { ReactElement } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelTypeSchema } from '../api.ts'
import type { Translate } from '../locales.ts'
import { platformMeta } from './platform.ts'
import { colors, styles } from './ui.ts'

export interface PlatformPickerProps {
  t: Translate
  schemas: readonly ChannelTypeSchema[]
  onPick: (channelType: string) => void
  onClose: () => void
}

export function PlatformPicker({ t, schemas, onPick, onClose }: PlatformPickerProps): ReactElement {
  return (
    <Modal
      open
      onClose={onClose}
      title={t('channels.picker.title')}
      closeLabel={t('channels.action.close')}
      description={t('channels.picker.hint')}
      className="tentacle-platform-dialog"
      contentClassName="tentacle-platform-content"
      footer={(
        <div style={{ display: 'flex', width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>{t('channels.action.cancel')}</Button>
        </div>
      )}
    >
      <div style={styles.platformGrid}>
        {schemas.map((schema) => {
          const meta = platformMeta(schema.channelType)
          return (
            <button
              key={schema.channelType}
              type="button"
              style={styles.platformCard}
              onClick={() => onPick(schema.channelType)}
            >
              <span style={styles.platformIcon} aria-hidden="true">{meta.emoji}</span>
              <span style={{ minWidth: 0, display: 'grid', gap: 3, textAlign: 'left' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{meta.label}</span>
                <span style={{ fontSize: 11, color: colors.tertiary, fontFamily: colors.code }}>{schema.channelType}</span>
              </span>
              {schema.quickSetup === true && <Tag tone="success">{t('channels.picker.quick')}</Tag>}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
