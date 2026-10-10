import type { BufferView, SentenceStore } from '../autosave/SentenceStore'
import { normalizedSentence } from '../autosave/SentenceStore'

export function SentencePanel({ buffer, store, busy, onEdit, onEditNotes, onPlan, planBusy, canPlan, onCheck, checkBusy, canCheck }: { buffer: BufferView; store: SentenceStore; busy: boolean; onEdit: (text: string) => void; onEditNotes: (notes: string) => void; onPlan?: () => void; planBusy?: boolean; canPlan?: boolean; onCheck?: () => void; checkBusy?: boolean; canCheck?: boolean }) {
  return <div className="sentence-editor">
    <label htmlFor={`sentence-${buffer.id}`}>My sentence</label>
    <textarea id={`sentence-${buffer.id}`} rows={7} maxLength={4000} value={buffer.text} disabled={buffer.problem === 'deleted' || buffer.recoveries.length > 0} onChange={event => onEdit(event.target.value)} placeholder="Write your own sentence here." />
    <div className="save-line"><span role="status">{buffer.state}</span><span className="muted">{Array.from(buffer.text).length}/4000 characters</span></div>
    <p className="muted">Fragments and multiple sentences stay as entered. Saving does not rewrite your words.</p>
    {onCheck && <button disabled={!canCheck || checkBusy} onClick={onCheck}>{checkBusy ? 'Checking…' : 'Check my sentence'}</button>}
    <label htmlFor={`notes-${buffer.id}`}>My rough notes</label>
    <textarea id={`notes-${buffer.id}`} rows={4} maxLength={4000} value={buffer.notes} disabled={buffer.problem === 'deleted' || buffer.recoveries.length > 0} onChange={event => onEditNotes(event.target.value)} placeholder="Ideas, details or questions in any language." />
    <p className="muted">{Array.from(buffer.notes).length}/4000 characters · Sentence and notes save together. Notes do not count toward paragraph words.</p>
    {onPlan && <><button disabled={!canPlan || planBusy} onClick={onPlan}>{planBusy ? 'Making plan…' : 'Make plan from my notes'}</button>{!normalizedSentence(buffer.notes) && <p className="muted">Add rough notes before requesting a plan.</p>}</>}
    {buffer.message && <p role="alert">{buffer.message}</p>}
    {buffer.problem === 'error' && <button className="secondary" disabled={busy} onClick={() => void store.retry(buffer.id)}>Retry writing save</button>}
    {buffer.problem === 'conflict' && <div className="conflict"><h3>Saved writing changed</h3><h4>Saved sentence</h4><p className="saved-text">{buffer.serverText || '(Empty saved sentence)'}</p><h4>Saved notes</h4><p className="saved-text">{buffer.serverNotes || '(Empty saved notes)'}</p><p>Your choice applies to both the sentence and notes.</p><div className="actions"><button disabled={busy} onClick={() => void store.keep(buffer.id)}>Keep my writing</button><button className="secondary" disabled={busy} onClick={() => store.useSaved(buffer.id)}>Use saved writing</button></div></div>}
    {buffer.recoveries.length > 0 && <div className="recovery"><h3>Local recovery copies found</h3><p>Review a copy before restoring it. Restoring checks the latest saved version first.</p>{buffer.recoveries.map(copy => <article key={copy.key}><p className="muted">{new Date(copy.value.updated_at).toLocaleString()}</p><h4>Sentence copy</h4><p className="saved-text">{copy.value.text || '(Empty sentence)'}</p>{copy.value.version === 2 ? <><h4>Notes copy</h4><p className="saved-text">{copy.value.notes || '(Empty notes)'}</p></> : <p className="muted">This earlier copy contains only a sentence. Saved notes will be kept.</p>}<div className="actions"><button disabled={busy} onClick={() => void store.restore(buffer.id, copy)}>Restore copy</button><button className="secondary" disabled={busy} onClick={() => store.discardRecovery(buffer.id, copy)}>Discard copy</button></div></article>)}</div>}
    {buffer.problem === 'deleted' && <><p>Copy any writing you want to keep before discarding this local buffer.</p><button className="secondary" disabled={busy || buffer.recoveries.length > 0} onClick={() => store.useSaved(buffer.id)}>Discard local sentence</button></>}
  </div>
}
