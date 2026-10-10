import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/writing'
import { useOperation, useResource } from '../hooks/useRequest'
import type { DraftInput, DraftSummary } from '../types/writing'
import type { PageProps } from '../App'
import { MetadataForm, emptyDraft } from '../components/MetadataForm'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Failure } from '../components/Failure'
import { discardDraftCopies } from '../autosave/recovery'

export function DraftsPage({ navigate, onGuard }: PageProps) {
  const load = useCallback((signal: AbortSignal) => api.list(signal), [])
  const resource = useResource(load)
  const operation = useOperation()
  const [creating, setCreating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [deleting, setDeleting] = useState<DraftSummary | null>(null)
  const [discard, setDiscard] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [storageWarning, setStorageWarning] = useState('')
  useEffect(() => { onGuard({ dirty, busy: operation.busy }); return () => onGuard({ dirty: false, busy: false }) }, [dirty, operation.busy, onGuard])
  async function create(body: DraftInput) {
    let created: DraftSummary | null = null
    const success = await operation.run(async signal => { created = await api.create(body, signal) }, error => { if (error.status === 0) setNeedsRefresh(true) })
    if (success && created) { onGuard({ dirty: false, busy: false }); navigate(`#/drafts/${(created as DraftSummary).id}`) }
  }
  async function remove(draft: DraftSummary) {
    setDeleting(null)
    let saved = false
    await operation.run(async signal => {
      await api.deleteDraft(draft, signal)
      saved = true
      setStorageWarning(discardDraftCopies(draft))
      resource.setData(await api.list(signal))
    }, error => { if (saved || error.status === 0 || error.status === 409) setNeedsRefresh(true) })
  }
  async function refresh() {
    await operation.run(async signal => { resource.setData(await api.list(signal)); setNeedsRefresh(false) })
  }
  return <main>
    <section className="page-heading"><div><p className="eyebrow">One intention at a time</p><h1>Your drafts</h1><p className="intro">Give each sentence a purpose. Start with one short paragraph.</p></div><button disabled={operation.busy || creating || needsRefresh} onClick={() => { operation.clearError(); setCreating(true) }}>New draft</button></section>
    <Failure error={operation.error} busy={operation.busy} onRetry={needsRefresh ? refresh : undefined} retryLabel="Refresh saved data" />
    {storageWarning && <p role="alert">{storageWarning}</p>}
    {needsRefresh && <p className="advisory">Refresh before another change. Your entries stay here; review the draft list before creating again.</p>}
    {operation.busy && <p role="status">Saving changes…</p>}
    {creating && <section className="panel editor"><h2>New draft</h2><MetadataForm kind="draft" initial={emptyDraft} busy={operation.busy} blocked={needsRefresh} onDirty={setDirty} onSubmit={value => void create(value as DraftInput)} onCancel={() => dirty ? setDiscard(true) : setCreating(false)} /></section>}
    {resource.loading && <p role="status">Loading drafts…</p>}
    <Failure error={resource.error} onRetry={resource.retry} retryLabel="Retry loading drafts" />
    {!resource.loading && !resource.error && resource.data?.length === 0 && <section className="empty"><h2>A clear paragraph starts with a plan.</h2><p>Create a draft with a topic and a sentence target. Add your own intentions or generate a sequence.</p></section>}
    <div className="draft-grid" aria-label="Saved drafts">{resource.data?.map(draft => <article className="panel draft-card" key={draft.id}>
      <h2><button className="text-link" disabled={operation.busy} onClick={() => navigate(`#/drafts/${draft.id}`)}>{draft.title}</button></h2><p className="topic">{draft.topic}</p>
      <p className="muted">{draft.intention_count} intentions · {draft.target_sentence_count} planned sentences</p>
      {draft.last_generation_mode === 'fake' && <p className="demo-label">Last generated in demo mode</p>}
      <div className="card-bottom"><span className="muted">Updated {new Date(draft.updated_at).toLocaleDateString()}</span><button className="secondary small" disabled={operation.busy || creating || needsRefresh || resource.loading || resource.error !== null} onClick={() => { operation.clearError(); setDeleting(draft) }} aria-label={`Delete draft ${draft.title}`}>Delete</button></div>
    </article>)}</div>
    {deleting && <ConfirmDialog title="Delete this draft?" message={`“${deleting.title}” and all its intentions, saved notes and sentences will be permanently deleted.`} onCancel={() => setDeleting(null)} onConfirm={() => void remove(deleting)} />}
    {discard && <ConfirmDialog title="Discard unsaved changes?" message="The new draft has not been saved. Your entered settings will be lost." confirmLabel="Discard changes" onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setCreating(false); operation.clearError() }} />}
  </main>
}
