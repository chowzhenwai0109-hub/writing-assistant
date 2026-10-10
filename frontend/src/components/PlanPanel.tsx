import type { usePlan } from '../hooks/usePlan'
import type { HelpLevel } from '../types/writing'
import { Failure } from './Failure'

export function PlanPanel({ plan, level, onRefresh }: { plan: ReturnType<typeof usePlan>; level: HelpLevel; onRefresh: () => void }) {
  const result = plan.result?.result
  return <section className="plan-result" aria-labelledby="plan-title">
    <h3 id="plan-title">Sentence plan</h3>
    {plan.busy && <p role="status">Planning from your saved notes…</p>}
    <Failure error={plan.error} />
    {plan.error?.status === 409 && <button className="secondary" onClick={onRefresh}>Refresh saved data</button>}
    {plan.result?.mode === 'fake' && <p className="demo-label">Demo plan · Generic practice roles, not a translation or live model output.</p>}
    {!result && !plan.busy && !plan.error && <p className="empty-note">Use your rough notes to request a plan. Your sentence stays in your hands.</p>}
    {result && <><h4>Slots</h4>{result.slots.length ? <ul>{result.slots.map((slot, i) => <li key={i}><strong>{slot.role}</strong><p>{slot.content}</p></li>)}</ul> : <p className="muted">None identified.</p>}
      <h4>Gaps</h4>{result.gaps.length ? <ul>{result.gaps.map((gap, i) => <li key={i}><strong>{gap.missing}</strong><p>{gap.question}</p></li>)}</ul> : <p className="muted">None identified.</p>}
      <h4>Ordering suggestion</h4><p>{result.ordering_suggestion}</p>
      <h4>Matched keywords</h4>{result.matched_keywords.length ? <ul>{result.matched_keywords.map((keyword, i) => <li key={i}><strong>{keyword.phrase}</strong><p>{keyword.note}</p></li>)}</ul> : <p className="muted">None suggested.</p>}
      {level !== 'hint' && <><h4>Matched structures</h4>{result.matched_structures.length ? <ul>{result.matched_structures.map((structure, i) => <li key={i}><strong>{structure.pattern}</strong><p>{structure.note}</p></li>)}</ul> : <p className="muted">None suggested.</p>}</>}
      {level === 'example' && <><h4>Plan examples</h4>{result.examples.length ? <ul>{result.examples.map((example, i) => <li key={i}><p>{example.sentence}</p><p className="muted">{example.why_it_works}</p></li>)}</ul> : <p className="muted">None suggested.</p>}<p className="muted">Examples are guidance; they are never inserted into your sentence.</p></>}
    </>}
  </section>
}
