import { useEffect, useState } from 'react'
import { checkFingerprint } from '../api/hintsContext'
import type { Draft, SavedCheck } from '../types/writing'
import type { useCheck } from '../hooks/useCheck'
import { Failure } from './Failure'

export function CheckPanel({ draft, id, hidden, check, onRefresh }: { draft: Draft | null; id?: number; hidden: boolean; check: ReturnType<typeof useCheck>; onRefresh: () => void }) {
  const [verified, setVerified] = useState<{ draft: Draft; id: number; feedback: SavedCheck } | null>(null)
  useEffect(() => {
    let active = true
    setVerified(null)
    const item = draft?.intentions.find(item => item.id === id)
    if (!hidden && draft && id !== undefined && item?.last_check_json) {
      void checkFingerprint(draft, id).then(fp => { if (active && fp === item.last_check_fingerprint) setVerified({ draft, id, feedback: item.last_check_json! }) }).catch(() => {})
    }
    return () => { active = false }
  }, [draft, id, hidden])
  const feedback = !hidden && verified?.draft === draft && verified.id === id ? verified.feedback : null
  return <section className="check-result" aria-labelledby="check-title">
    <h3 id="check-title">Sentence check</h3>
    <p className="muted">Advisory feedback. Checked means reviewed, regardless of the verdict.</p>
    {check.busy && <p role="status">Checking your sentence…</p>}
    <Failure error={check.error} />
    {check.needsRefresh && <><p className="advisory">Refresh saved data before another request. The server may have saved the check; your writing is retained.</p><button className="secondary" disabled={check.busy} onClick={onRefresh}>Refresh saved data</button></>}
    {!feedback && !check.busy && !check.error && !check.needsRefresh && <p className="empty-note">Write and check your sentence to see feedback for the saved context.</p>}
    {feedback && <>
      {feedback.mode === 'fake' && <p className="demo-label">Demo check · Illustrative feedback, not live model judgment.</p>}
      <h4>Fulfils intention: {feedback.result.fulfils_intention}</h4><p>{feedback.result.summary}</p>
      <h4>Issues</h4>{feedback.result.issues.length ? <ul>{feedback.result.issues.map((issue, index) => <li key={index}><strong>{issue.type.replaceAll('_', ' ')}</strong><p>{issue.message}</p><p>{issue.suggestion}</p></li>)}</ul> : <p className="muted">No issues suggested.</p>}
    </>}
  </section>
}
