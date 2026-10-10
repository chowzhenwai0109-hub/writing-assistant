import type { HelpLevel } from '../types/writing'
import type { useHints } from '../hooks/useHints'
import { Failure } from './Failure'
import { PlanPanel } from './PlanPanel'
import type { usePlan } from '../hooks/usePlan'
import type { ReactNode } from 'react'

export function GuidancePanel({ level, onLevel, hints, plan, disabled, onRefresh, children }: { level: HelpLevel; onLevel: (level: HelpLevel) => void; hints: ReturnType<typeof useHints>; plan: ReturnType<typeof usePlan>; disabled: boolean; onRefresh: () => void; children?: ReactNode }) {
  const result = hints.result?.result
  return <section className="panel guidance" aria-labelledby="guidance-title">
    <h2 id="guidance-title">Writing guidance</h2>
    <label htmlFor="help-level">Help level</label><select id="help-level" value={level} onChange={event => { hints.invalidate(); plan.invalidate(); onLevel(event.target.value as HelpLevel) }}><option value="hint">Hint</option><option value="structure">Structure</option><option value="example">Example</option></select>
    <p className="muted">{level === 'hint' ? 'Ideas and useful words to help you write.' : level === 'structure' ? 'Ideas plus patterns with slots for your own words.' : 'Ideas, patterns, and complete example sentences.'}</p>
    <button disabled={disabled || hints.busy || plan.busy} onClick={() => void hints.get()}>{hints.busy ? 'Getting hints…' : 'Get Hints'}</button>
    <Failure error={hints.error} />
    {hints.error?.status === 409 && <button className="secondary" onClick={onRefresh}>Refresh saved data</button>}
    {hints.result?.mode === 'fake' && <p className="demo-label">Demo guidance · Generic practice material, not live model output.</p>}
    {!result && !hints.busy && !hints.error && <p className="empty-note">Choose an intention and request guidance when you need it. Changing your writing or help level clears older guidance.</p>}
    {result && <div className="guidance-result"><h3>Hint guidance</h3><h4>Intention</h4><p>{result.intention_summary}</p><h4>Relationship</h4><p>{result.relationship}</p>
      <h4>Entities</h4>{result.entities.length ? <ul>{result.entities.map((item, i) => <li key={i}><strong>{item.label}</strong><p>{item.why_needed}</p></li>)}</ul> : <p className="muted">None suggested.</p>}
      <h4>Keywords</h4>{result.keywords.length ? <ul>{result.keywords.map((item, i) => <li key={i}><strong>{item.phrase}</strong><p>{item.note}</p></li>)}</ul> : <p className="muted">None suggested.</p>}
      <h4>Connectives</h4>{result.connectives.length ? <ul>{result.connectives.map((item, i) => <li key={i}><strong>{item.word}</strong><p>{item.use}</p></li>)}</ul> : <p className="muted">None suggested.</p>}
      {level !== 'hint' && <><h4>Structures</h4>{result.structures.length ? <ul>{result.structures.map((item, i) => <li key={i}><strong>{item.pattern}</strong><p>{item.note}</p></li>)}</ul> : <p className="muted">None suggested.</p>}</>}
      {level === 'example' && <><h4>Examples</h4>{result.examples.length ? <ul>{result.examples.map((item, i) => <li key={i}><p>{item.sentence}</p><p className="muted">{item.why_it_works}</p></li>)}</ul> : <p className="muted">None suggested.</p>}<p className="muted">Examples are guidance. Write your own sentence in the editor.</p></>}
    </div>}
    <PlanPanel plan={plan} level={level} onRefresh={onRefresh} />
    {children}
  </section>
}
