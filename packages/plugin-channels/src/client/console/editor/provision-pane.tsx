/**
 * The quick-setup (QR) pane of the create dialog (design 08 §3).
 *
 * Lifecycle, all owned here: start on mount, poll every `pollAfterMs`
 * (default 2s, the reference implementation's cadence), auto-create on success (the HOST does it —
 * this pane only learns the instance), regenerate on failure/expiry, and
 * always stop the flow when the pane goes away (close, type switch, success).
 * Platform secrets never appear: the status projection carries a QR URL and
 * at most a user code, which is why the QR is safe to render client-side.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import QRCodeGenerator from 'qrcode-generator'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  channelsCall,
  errorText,
  type ChannelInstanceView,
  type ChannelTarget,
  type ProvisionStatus,
} from '../../api.ts'
import type { Translate } from '../../locales.ts'
import type { ToastFn } from '../contracts.ts'
import { colors, styles } from '../ui.ts'

export interface ProvisionPaneProps {
  t: Translate
  channelType: string
  /**
   * Repair mode: rotate THIS instance's credentials on success (re-scan after
   * a platform session expiry) instead of creating a new channel.
   */
  instanceId?: string
  /**
   * The routing target a newly created channel points at (design 09 §3.3 for
   * experts, 10 §7 for teams). Required for creation and absent in repair
   * mode (the instance keeps its own binding).
   */
  target?: ChannelTarget
  onSaved: (instance: ChannelInstanceView) => void
  onToast: ToastFn
}

export function ProvisionPane({ t, channelType, instanceId, target, onSaved, onToast }: ProvisionPaneProps): ReactElement {
  const [status, setStatus] = useState<ProvisionStatus | undefined>(undefined)
  const [startError, setStartError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // The flow id lives in a ref: timers and the unmount cleanup must see the
  // CURRENT value, not the one their closure captured.
  const flowRef = useRef<string | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const inFlightRef = useRef(false)
  const aliveRef = useRef(true)

  const stopTimer = (): void => {
    if (timerRef.current !== undefined) clearInterval(timerRef.current)
    timerRef.current = undefined
  }

  const stopFlow = (): void => {
    stopTimer()
    const flowId = flowRef.current
    flowRef.current = undefined
    if (flowId !== undefined) {
      // Best effort: a consumed or expired session 404s, which is fine.
      void channelsCall('/provision/stop', { flowId }).catch(() => undefined)
    }
  }

  const begin = async (): Promise<void> => {
    stopFlow()
    setBusy(true)
    setStartError(undefined)
    setStatus(undefined)
    try {
      const started = await channelsCall<ProvisionStatus>('/provision/start', {
        channelType,
        ...(instanceId === undefined ? {} : { instanceId }),
        ...(target === undefined ? {} : { target }),
      })
      if (!aliveRef.current) return
      flowRef.current = started.flowId
      setStatus(started)
      timerRef.current = setInterval(() => void poll(), started.state === 'waiting' || started.state === 'pending'
        ? started.pollAfterMs ?? 2000
        : 2000)
    } catch (error) {
      if (aliveRef.current) setStartError(errorText(t, error))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const poll = async (): Promise<void> => {
    const flowId = flowRef.current
    if (flowId === undefined || inFlightRef.current) return
    inFlightRef.current = true
    try {
      const next = await channelsCall<ProvisionStatus>(`/provision/poll?flowId=${encodeURIComponent(flowId)}`)
      if (!aliveRef.current) return
      setStatus(next)
      if (next.state === 'success') {
        stopTimer()
        flowRef.current = undefined
        onToast(t('channels.toast.created'), 'success')
        onSaved(next.instance)
      } else if (next.state === 'failed' || next.state === 'expired') {
        stopTimer()
      }
    } catch (error) {
      // A transient transport error is not a flow failure; keep polling. A
      // consumed session (404 after success elsewhere) just stops the timer.
      if (aliveRef.current && (error as { status?: number }).status === 404) stopTimer()
    } finally {
      inFlightRef.current = false
    }
  }

  // Start on mount (the pane is keyed by channel type + target, so either
  // switch is a fresh mount); stop the flow on unmount, whatever the reason.
  useEffect(() => {
    aliveRef.current = true
    void begin()
    return () => {
      aliveRef.current = false
      stopFlow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelType, target, instanceId])

  const waiting = status === undefined || status.state === 'waiting' || status.state === 'pending'
  const qrUrl = waiting && status !== undefined && (status.state === 'waiting' || status.state === 'pending') ? status.qrUrl : undefined
  // QR URLs are encoded client-side by `qrcode-generator` (zero-dependency,
  // synchronous GIF data URL — no canvas, no server round trip).
  const qrImage = useMemo(() => {
    if (qrUrl === undefined) return undefined
    const qr = QRCodeGenerator(0, 'M')
    qr.addData(qrUrl)
    qr.make()
    return qr.createDataURL(4, 2)
  }, [qrUrl])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '8px 0' }}>
      {startError !== undefined && <Tag tone="danger">{startError}</Tag>}
      {status?.state === 'failed' && <Tag tone="danger">{status.error}</Tag>}
      {status?.state === 'expired' && <Tag tone="warning">{t('channels.provision.expired')}</Tag>}
      <div
        style={{
          width: 236,
          height: 236,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          background: colors.layer1,
        }}
      >
        {qrImage !== undefined && waiting
          ? <img src={qrImage} alt={t('channels.provision.qrAlt')} width={220} height={220} />
          : <span style={styles.hint}>{busy ? t('channels.provision.starting') : t('channels.provision.noQr')}</span>}
      </div>
      {waiting && status !== undefined && (status.state === 'waiting' || status.state === 'pending') && status.userCode !== undefined && (
        <span style={{ ...styles.factValue, fontSize: 18, letterSpacing: 2 }}>{status.userCode}</span>
      )}
      <span style={{ ...styles.hint, textAlign: 'center' }}>
        {status?.state === 'failed'
          ? t('channels.provision.failedHint')
          : status?.state === 'expired'
            ? t('channels.provision.expiredHint')
            : t('channels.provision.hint')}
      </span>
      {waiting && status !== undefined && (status.state === 'waiting' || status.state === 'pending') && status.message !== undefined && (
        <span style={styles.tiny}>{status.message}</span>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void begin()}>
        {t('channels.provision.regenerate')}
      </Button>
      {qrUrl === undefined && waiting && !busy && startError === undefined && null}
    </div>
  )
}
