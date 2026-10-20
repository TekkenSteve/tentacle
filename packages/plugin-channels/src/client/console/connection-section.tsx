/**
 * Connection / credential section of one instance (design 08 §4 recovery).
 *
 * A platform session can die after a successful login — WeChat iLink answers
 * every request with `errcode=-14` and the adapter can only recover with fresh
 * credentials. This section is the recovery entry point: it shows the live
 * runtime verdict and, for platforms that declare a quick-setup flow, offers
 * the same QR wizard in REPAIR mode (`instanceId`), which rotates credentials
 * in place instead of creating a duplicate instance.
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelInstanceView } from '../api.ts'
import { fmt, type Translate } from '../locales.ts'
import type { ToastFn } from './contracts.ts'
import { ProvisionPane } from './editor/provision-pane.tsx'
import { colors, styles } from './ui.ts'

export interface ConnectionSectionProps {
  t: Translate
  instance: ChannelInstanceView
  /** The platform declares a quick-setup flow, so re-scanning can repair it. */
  readonly canRepair: boolean
  onToast: ToastFn
  reload: () => void
}

export function ConnectionSection({ t, instance, canRepair, onToast, reload }: ConnectionSectionProps): ReactElement {
  const [open, setOpen] = useState(false)
  const runtime = instance.runtime
  const badge = runtime.state === 'connected'
    ? { tone: 'success' as const, label: t('channels.badge.connected') }
    : runtime.state === 'failed'
      ? { tone: 'danger' as const, label: t('channels.badge.failed') }
      : runtime.state === 'pending'
        ? { tone: 'warning' as const, label: t('channels.badge.pending') }
        : { tone: 'quiet' as const, label: t('channels.badge.disabled') }

  return (
    <div style={styles.stack}>
      <div style={styles.row}>
        <Tag tone={badge.tone}>{badge.label}</Tag>
        {instance.credential.configured
          ? <Tag tone="quiet">{t('channels.connection.credentialReady')}</Tag>
          : <Tag tone="warning">{t('channels.connection.credentialMissing')}</Tag>}
      </div>
      {runtime.state === 'failed' && runtime.error !== undefined && (
        <p style={{ ...styles.hint, color: colors.danger }}>{runtime.error}</p>
      )}
      <p style={styles.hint}>{t('channels.connection.hint')}</p>
      {canRepair && (
        <div style={styles.row}>
          <Button variant="outline" onClick={() => setOpen(true)}>
            {t('channels.action.repairQr')}
          </Button>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={fmt(t('channels.repair.title'), { name: instance.name })}
        closeLabel={t('channels.action.close')}
        description={t('channels.repair.hint')}
      >
        {open && (
          <ProvisionPane
            key={instance.id}
            t={t}
            channelType={instance.channelType}
            instanceId={instance.id}
            onSaved={() => {
              setOpen(false)
              onToast(t('channels.toast.repaired'), 'success')
              reload()
            }}
            onToast={onToast}
          />
        )}
      </Modal>
    </div>
  )
}
