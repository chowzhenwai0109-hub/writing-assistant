import { useEffect, useId, useRef } from 'react'

export function ConfirmDialog({ title, message, confirmLabel = 'Delete', busy = false, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel?: string; busy?: boolean; onConfirm: () => void; onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    cancel.current?.focus()
    return () => { element.close() }
  }, [])
  return <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}>
    <h2 id={titleId}>{title}</h2><p>{message}</p>
    <div className="actions"><button ref={cancel} className="secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="danger" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</button></div>
  </dialog>
}
