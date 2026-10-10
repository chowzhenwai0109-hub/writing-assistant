import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type { DraftInput, IntentionInput } from '../types/writing'
import { LengthSummary } from './LengthSummary'

export const emptyDraft: DraftInput = { title: '', topic: '', task_description: '', target_sentence_count: 5, target_word_min: null, target_word_max: null }
export const emptyIntention: IntentionInput = { function_label: '', description: '', guiding_question: '' }

export function MetadataForm({ kind, initial, busy, blocked = false, onSubmit, onCancel, onDirty }: {
  kind: 'draft' | 'intention'; initial: DraftInput | IntentionInput; busy: boolean; blocked?: boolean
  onSubmit: (value: DraftInput | IntentionInput) => void; onCancel: () => void; onDirty: (value: boolean) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, value === null ? '' : String(value)])))
  const [validation, setValidation] = useState('')
  const dirty = Object.entries(initial).some(([key, value]) => values[key] !== (value === null ? '' : String(value)))
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  function field(name: string, label: string, maxLength: number, required = true, multiline = false) {
    const attributes = { id: `field-${name}`, name, value: values[name], maxLength, required, autoFocus: name === 'title' || name === 'function_label', onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues(current => ({ ...current, [name]: event.target.value })) }
    return <label htmlFor={attributes.id}>{label}{multiline ? <textarea {...attributes} rows={name === 'topic' ? 3 : 4} /> : <input {...attributes} />}</label>
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || blocked) return
    const required = kind === 'draft' ? ['title', 'topic'] : ['function_label', 'description', 'guiding_question']
    if (required.some(key => !values[key].trim())) { setValidation('Required fields cannot contain only spaces.'); return }
    if (kind === 'intention') { setValidation(''); onSubmit(values as IntentionInput); return }
    const count = Number(values.target_sentence_count)
    const low = values.target_word_min === '' ? null : Number(values.target_word_min)
    const high = values.target_word_max === '' ? null : Number(values.target_word_max)
    if (!Number.isInteger(count) || count < 3 || count > 8 || (low === null) !== (high === null) ||
      (low !== null && high !== null && (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 500 || low > high))) {
      setValidation('Choose 3–8 sentences and provide both word bounds (1–500, minimum ≤ maximum), or leave both empty.'); return
    }
    setValidation('')
    onSubmit({ title: values.title.trim(), topic: values.topic.trim(), task_description: values.task_description, target_sentence_count: count, target_word_min: low, target_word_max: high })
  }
  const settings = kind === 'draft' ? { target_sentence_count: Number(values.target_sentence_count), target_word_min: values.target_word_min === '' ? null : Number(values.target_word_min), target_word_max: values.target_word_max === '' ? null : Number(values.target_word_max) } : null
  return <form onSubmit={submit} aria-label={kind === 'draft' ? 'Draft settings' : 'Intention details'}>
    <fieldset disabled={busy}>
      {kind === 'draft' ? <>
        {field('title', 'Title', 200)}{field('topic', 'Topic', 2000, true, true)}
        {field('task_description', 'Task, audience, purpose, and tone (optional)', 4000, false, true)}
        <label htmlFor="field-count">Planned sentences<select id="field-count" value={values.target_sentence_count} onChange={event => setValues(current => ({ ...current, target_sentence_count: event.target.value }))}>{[3, 4, 5, 6, 7, 8].map(count => <option key={count}>{count}</option>)}</select></label>
        <div className="form-row">{[['target_word_min', 'Minimum words (optional)'], ['target_word_max', 'Maximum words (optional)']].map(([key, label]) => <label key={key} htmlFor={`field-${key}`}>{label}<input id={`field-${key}`} type="number" min="1" max="500" step="1" value={values[key]} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
        <p className="muted">Word targets apply to the whole paragraph. Leave both empty to skip a target.</p>
        {settings && settings.target_sentence_count > 0 && (settings.target_word_min === null && settings.target_word_max === null || settings.target_word_min !== null && settings.target_word_max !== null && settings.target_word_min <= settings.target_word_max) && <LengthSummary settings={settings} />}
      </> : <>{field('function_label', 'Primary purpose', 200)}{field('description', 'Description', 1000, true, true)}{field('guiding_question', 'Guiding question', 1000, true, true)}</>}
    </fieldset>
    {validation && <p role="alert" className="error-box">{validation}</p>}
    <div className="actions"><button type="submit" disabled={busy || blocked}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>
}
