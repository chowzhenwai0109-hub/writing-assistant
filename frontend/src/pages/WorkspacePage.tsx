import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/writing'
import { useOperation, useResource } from '../hooks/useRequest'
import type { Draft, DraftInput, HelpLevel, Intention, IntentionInput } from '../types/writing'
import type { PageProps } from '../App'
import { MetadataForm, emptyIntention } from '../components/MetadataForm'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { LengthSummary } from '../components/LengthSummary'
import { Failure } from '../components/Failure'
import { SentencePanel } from '../components/SentencePanel'
import { GuidancePanel } from '../components/GuidancePanel'
import { useSentenceAutosave } from '../hooks/useSentenceAutosave'
import { useHints } from '../hooks/useHints'
import { usePlan } from '../hooks/usePlan'
import { useCheck } from '../hooks/useCheck'
import { CheckPanel } from '../components/CheckPanel'
import { normalizedSentence } from '../autosave/SentenceStore'

type Editor = { kind: 'settings'; base: Draft } | { kind: 'add'; base: Draft } | { kind: 'edit'; base: Intention }
type Confirmation = { title: string; message: string; label: string; action: () => void }
const draftFields = (draft: Draft): DraftInput => ({ title: draft.title, topic: draft.topic, task_description: draft.task_description, target_sentence_count: draft.target_sentence_count, target_word_min: draft.target_word_min, target_word_max: draft.target_word_max })
const intentionFields = (item: Intention): IntentionInput => ({ function_label: item.function_label, description: item.description, guiding_question: item.guiding_question })

export function WorkspacePage({ id, navigate, onGuard, level = 'hint', onLevel = () => {} }: PageProps & { id: number; level?: HelpLevel; onLevel?: (level: HelpLevel) => void }) {
  const load = useCallback((signal: AbortSignal) => api.get(id, signal), [id])
  const resource = useResource(load)
  const operation = useOperation()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [formVersion, setFormVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const detailContainer = useRef<HTMLElement>(null)
  const { store, snapshot } = useSentenceAutosave(id, resource.data, resource.setData)
  const draft = snapshot.draft ?? resource.data
  const selected = draft?.intentions.find(item => item.id === selectedId) ?? draft?.intentions[0]
  const hints = useHints(store, selected?.id, level)
  const plan = usePlan(store, selected?.id, level)
  const check = useCheck(store, selected?.id)
  function invalidateGuidance() { hints.invalidate(); plan.invalidate(); check.invalidate() }
  const busy = operation.busy || snapshot.saving || hints.busy || plan.busy || check.busy
  useEffect(() => { onGuard({ dirty: dirty || snapshot.pending, busy }); return () => onGuard({ dirty: false, busy: false }) }, [dirty, snapshot.pending, busy, onGuard])

  function focusDetail(selector: string) {
    const container = detailContainer.current
    window.setTimeout(() => { if (container?.isConnected) container.querySelector<HTMLElement>(selector)?.focus() }, 0)
  }
  function closeEditor() { setEditor(null); setDirty(false); setConflict(false); operation.clearError(); focusDetail('#detail-title') }
  function beginEditor(value: Editor) { invalidateGuidance(); setEditor(value); setFormVersion(value => value + 1); setConflict(false); operation.clearError() }
  async function write(action: (signal: AbortSignal) => Promise<Draft | void>, close = false) {
    invalidateGuidance()
    let saved = false
    const success = await operation.run(async signal => {
      try {
        const result = await action(signal)
        saved = true
        const latest = result ?? await api.get(id, signal)
        resource.setData(latest)
        store.acceptDraft(latest)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try { const latest = await api.get(id, signal); store.acceptDraft(latest); resource.setData(latest); setConflict(editor !== null) } catch { setNeedsRefresh(true) }
        } else if (saved || error instanceof ApiError && error.status === 0) setNeedsRefresh(true)
        if (saved) throw new ApiError(0, 'Your change was saved, but refreshing the draft failed. Refresh saved data before another change.')
        throw error
      }
    })
    if (success && close) closeEditor()
  }
  async function refresh() {
    await operation.run(async signal => { const latest = await api.get(id, signal); store.acceptDraft(latest); resource.setData(latest); setNeedsRefresh(false); check.reconciled(); setConflict(editor !== null) })
  }
  function cancelEditor() {
    if (!dirty) { closeEditor(); return }
    setConfirmation({ title: 'Discard unsaved changes?', message: 'Your entered settings or intention details have not been saved and will be lost.', label: 'Discard changes', action: closeEditor })
  }
  function resolveConflict(keep: boolean) {
    if (!editor || !draft) return
    const latest: Editor | null = editor.kind === 'edit'
      ? (() => { const item = draft.intentions.find(item => item.id === editor.base.id); return item ? { kind: 'edit', base: item } : null })()
      : { kind: editor.kind, base: draft }
    if (!latest) { closeEditor(); return }
    setEditor(latest)
    if (!keep) setFormVersion(value => value + 1)
    setConflict(false)
    operation.clearError()
    if (keep) focusDetail('input, textarea')
  }
  function submit(value: DraftInput | IntentionInput) {
    if (!editor || conflict || needsRefresh) return
    if (editor.kind === 'settings') void write(async signal => { await api.settings(editor.base, value as DraftInput, signal) }, true)
    else if (editor.kind === 'add') void write(async signal => { const item = await api.add(editor.base, value as IntentionInput, signal); setSelectedId(item.id) }, true)
    else void write(async signal => { await api.edit(editor.base, value as IntentionInput, signal) }, true)
  }
  function generate() {
    if (!draft) return
    if (draft.intentions.length === 0) { void write(signal => api.generate(draft, false, signal)); return }
    setConfirmation({ title: 'Replace this sequence?', message: 'All current intentions, saved notes and sentences, plus their local recovery copies will be permanently removed after a valid replacement is ready. Failed generation keeps your current work.', label: 'Replace sequence', action: () => void write(async signal => { const result = await api.generate(draft, true, signal); store.discardDeleted(draft.intentions.map(item => item.id)); return result }) })
  }
  function remove(item: Intention) {
    if (!draft) return
    setConfirmation({ title: 'Delete this intention?', message: `“${item.function_label}” and its saved notes, sentence and local recovery copies will be permanently deleted.`, label: 'Delete intention', action: () => void write(async signal => { await api.deleteIntention(draft, item, signal); store.discardDeleted([item.id]) }) })
  }
  function reorder(item: Intention, direction: -1 | 1) {
    if (!draft) return
    const ids = draft.intentions.map(item => item.id)
    const index = ids.indexOf(item.id)
    const other = index + direction
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other], ids[index]]
    void write(signal => api.order(draft, ids, signal))
  }
  const locked = busy || snapshot.pending || editor !== null || needsRefresh || check.needsRefresh || resource.loading || resource.error !== null
  const selectedBuffer = selected && snapshot.buffers[selected.id]
  const visibleStatus = (item: Intention) => (snapshot.pending || check.needsRefresh) && item.status === 'checked' ? (normalizedSentence(snapshot.buffers[item.id]?.text ?? item.sentence_text ?? '') ? 'written' : 'pending') : item.status
  const liveDraft = draft && { ...draft, intentions: draft.intentions.map(item => ({ ...item, sentence_text: snapshot.buffers[item.id]?.text ?? item.sentence_text })) }
  return <main>
    <button className="text-link back" disabled={busy} onClick={() => navigate('#/drafts')}>← All drafts</button>
    {resource.loading && <p role="status">Loading draft…</p>}
    <Failure error={resource.error} onRetry={resource.retry} retryLabel="Retry loading draft" />
    <Failure error={operation.error} busy={operation.busy} onRetry={needsRefresh ? refresh : undefined} retryLabel="Refresh saved data" />
    {operation.busy && <p role="status">Saving or generating…</p>}
    {needsRefresh && <p className="advisory">Refresh saved data before making another change. Your entered details are preserved here.</p>}
    {snapshot.warning && <p role="alert" className="advisory">{snapshot.warning}</p>}
    {draft && <>
      <section className="page-heading workspace-heading"><div><p className="eyebrow">Paragraph plan</p><h1>{draft.title}</h1><p className="intro topic">{draft.topic}</p></div><button className="secondary" disabled={locked} onClick={() => beginEditor({ kind: 'settings', base: draft })}>Edit settings</button></section>
      {draft.last_generation_mode === 'fake' && <p className="demo-label">Last generated in demo mode · Generic practice guidance, not live model output.</p>}
      <LengthSummary settings={draft} draft={liveDraft ?? undefined} />
      <div className="workspace-grid">
        <section className="panel sequence" aria-labelledby="sequence-title"><div className="section-heading"><h2 id="sequence-title">Intention sequence</h2><span>{draft.intentions.length}/8</span></div>
          <div className="actions"><button disabled={locked} onClick={generate}>{operation.busy ? 'Working…' : 'Generate sequence'}</button><button className="secondary" disabled={locked || draft.intentions.length >= 8} onClick={() => beginEditor({ kind: 'add', base: draft })}>Add intention</button></div>
          {draft.intentions.length === 0 && <p className="empty-note">No intentions yet. Generate a plan or add the first purpose yourself.</p>}
          <ol className="intention-list">{draft.intentions.map((item, index) => <li key={item.id} className={selected?.id === item.id ? 'selected' : ''}>
            <button className="intention-select" aria-label={`${index + 1}. ${item.function_label} (${visibleStatus(item)})`} aria-pressed={selected?.id === item.id} disabled={editor !== null || operation.busy} onClick={() => { invalidateGuidance(); if (selected) void store.flush(selected.id); setSelectedId(item.id) }}><span className="step-number">{index + 1}</span><span>{item.function_label}</span><span className={`badge ${visibleStatus(item)}`}>{visibleStatus(item)}</span></button>
            <div className="item-actions"><button className="secondary small" disabled={locked} onClick={() => beginEditor({ kind: 'edit', base: item })} aria-label={`Edit intention ${index + 1}`}>Edit</button><button className="secondary small" disabled={locked || index === 0} onClick={() => reorder(item, -1)} aria-label={`Move intention ${index + 1} up`}>↑</button><button className="secondary small" disabled={locked || index === draft.intentions.length - 1} onClick={() => reorder(item, 1)} aria-label={`Move intention ${index + 1} down`}>↓</button><button className="secondary small" disabled={locked} onClick={() => remove(item)} aria-label={`Delete intention ${index + 1}`}>Delete</button></div>
          </li>)}</ol>
          {draft.intentions.length >= 8 && <p className="muted">Eight intentions is the maximum for one paragraph.</p>}
        </section>
        <section ref={detailContainer} className="panel detail" aria-labelledby="detail-title">
          {editor ? <>
            <h2 id="detail-title" tabIndex={-1}>{editor.kind === 'settings' ? 'Draft settings' : editor.kind === 'add' ? 'Add intention' : 'Edit intention'}</h2>
            {conflict && <div className="conflict" role="alert"><h3>Saved data changed</h3><p>Your entries are preserved. Review the saved version. Choose Keep my edits, then Save to submit them against the latest version, or Use saved version to replace your entries.</p>
              {editor.kind === 'edit' ? (() => { const latest = draft.intentions.find(item => item.id === editor.base.id); return latest ? <><p>Saved purpose: {latest.function_label}</p><p>Saved description: {latest.description}</p><p>Saved question: {latest.guiding_question}</p></> : <p>This intention was deleted. Your entries cannot be saved to it.</p> })() : <><p>Saved title: {draft.title}</p><p>Saved topic: {draft.topic}</p><p>Saved task: {draft.task_description || 'None'}</p><p>Saved targets: {draft.target_sentence_count} sentences; {draft.target_word_min === null ? 'no word range' : `${draft.target_word_min}–${draft.target_word_max} words`}</p></>}
              <div className="actions"><button disabled={editor.kind === 'edit' && !draft.intentions.some(item => item.id === editor.base.id)} onClick={() => resolveConflict(true)}>Keep my edits</button><button className="secondary" onClick={() => resolveConflict(false)}>Use saved version</button></div>
            </div>}
            <MetadataForm key={formVersion} kind={editor.kind === 'settings' ? 'draft' : 'intention'} initial={editor.kind === 'settings' ? draftFields(editor.base) : editor.kind === 'add' ? emptyIntention : intentionFields(editor.base)} busy={operation.busy} blocked={conflict || needsRefresh} onDirty={setDirty} onSubmit={submit} onCancel={cancelEditor} />
          </> : selected ? <><p className="eyebrow">Intention {selected.position + 1}</p><h2 id="detail-title" tabIndex={-1}>{selected.function_label}</h2><p className="purpose">{selected.description}</p><div className="question"><h3>Guiding question</h3><p>{selected.guiding_question}</p></div>{selectedBuffer && <SentencePanel buffer={selectedBuffer} store={store} busy={snapshot.saving} onEdit={text => { invalidateGuidance(); store.edit(selected.id, text) }} onEditNotes={notes => { invalidateGuidance(); store.editNotes(selected.id, notes) }} onPlan={() => void plan.get()} planBusy={plan.busy} canPlan={!hints.busy && !check.busy && !check.needsRefresh && !operation.busy && !needsRefresh && !selectedBuffer.problem && !selectedBuffer.recoveries.length && !!normalizedSentence(selectedBuffer.notes)} onCheck={() => void check.get()} checkBusy={check.busy} canCheck={!hints.busy && !plan.busy && !operation.busy && !needsRefresh && !check.needsRefresh && !selectedBuffer.problem && !selectedBuffer.recoveries.length && !!normalizedSentence(selectedBuffer.text)} />}<p className="muted">Focus on the primary purpose. A sentence can reasonably serve other purposes too.</p></> : <><h2 id="detail-title" tabIndex={-1}>Give the paragraph a direction.</h2><p>Each intention describes what one sentence should do. Start with a sequence, then make it yours.</p></>}
          {!editor && draft.task_description && <details><summary>Task, audience, purpose, and tone</summary><p className="saved-text">{draft.task_description}</p></details>}
        </section>
        <GuidancePanel level={level} onLevel={onLevel} hints={hints} plan={plan} disabled={!selected || editor !== null || operation.busy || needsRefresh || check.busy || check.needsRefresh || !!selectedBuffer?.problem || !!selectedBuffer?.recoveries.length} onRefresh={() => void refresh()}><CheckPanel draft={draft} id={selected?.id} hidden={snapshot.pending || editor !== null || check.needsRefresh} check={check} onRefresh={() => void refresh()} /></GuidancePanel>
      </div>
      {Object.values(snapshot.buffers).filter(buffer => !draft.intentions.some(item => item.id === buffer.id)).map(buffer => <section key={buffer.id} className="panel orphan"><h2>Removed intention: local writing</h2><SentencePanel buffer={buffer} store={store} busy={snapshot.saving} onEdit={() => {}} onEditNotes={() => {}} /></section>)}
    </>}
    {confirmation && <ConfirmDialog title={confirmation.title} message={confirmation.message} confirmLabel={confirmation.label} onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); action() }} />}
  </main>
}
