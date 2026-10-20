/**
 * The console's one confirmation dialog: a native `Modal` whose confirming
 * action is destructive (the palette has no danger button variant, so the
 * confirm action is a ghost `Button` carrying the error color).
 *
 * Every confirmation in the console goes through this component — nothing here
 * ever calls `window.confirm`.
 */
import type { ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { styles } from './ui.ts'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  closeLabel: string
  cancelLabel: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  closeLabel,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeLabel={closeLabel}
      description={description}
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="ghost" style={styles.danger} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    />
  )
}
