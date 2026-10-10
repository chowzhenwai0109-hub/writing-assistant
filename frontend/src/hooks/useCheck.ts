import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/writing'
import { checkFingerprint } from '../api/hintsContext'
import { normalizedSentence, type SentenceStore } from '../autosave/SentenceStore'

export function useCheck(store: SentenceStore, id: number | undefined) {
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const uncertain = useRef(false)
  const current = useRef<{ controller: AbortController; epoch?: number; sent: boolean } | null>(null)
  const invalidate = useCallback(() => {
    if (current.current?.sent) { uncertain.current = true; setNeedsRefresh(true) }
    current.current?.controller.abort(); current.current = null; setBusy(false); setError(null)
  }, [])
  const reconciled = useCallback(() => { uncertain.current = false; setNeedsRefresh(false); setError(null) }, [])
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      if (current.current?.epoch !== undefined && current.current.epoch !== store.getSnapshot().epoch) invalidate()
    })
    return () => { unsubscribe(); current.current?.controller.abort(); current.current = null }
  }, [store, invalidate])
  useEffect(() => { invalidate() }, [id, invalidate])
  async function get() {
    if (current.current || id === undefined || uncertain.current) return
    const pending = { controller: new AbortController(), epoch: undefined as number | undefined, sent: false }
    current.current = pending; setBusy(true); setError(null)
    try {
      if (!await store.flush()) throw new ApiError(422, 'Save or resolve pending writing before checking.')
      if (current.current !== pending) return
      const snapshot = store.getSnapshot(), draft = snapshot.draft, item = draft?.intentions.find(item => item.id === id)
      if (!draft || !item) throw new ApiError(404, 'The selected intention was removed.')
      if (!normalizedSentence(item.sentence_text ?? '')) throw new ApiError(422, 'Write a sentence before checking it.')
      pending.epoch = snapshot.epoch
      const fingerprint = await checkFingerprint(draft, id)
      if (current.current !== pending) return
      pending.sent = true
      const response = await api.check(id, item.sentence_text!, item.revision, draft.revision, pending.controller.signal)
      if (current.current !== pending || store.getSnapshot().epoch !== pending.epoch) return
      const returnedFingerprint = await checkFingerprint(response.draft, id)
      if (current.current !== pending || store.getSnapshot().epoch !== pending.epoch) return
      if (response.context_fingerprint !== fingerprint || response.intention_revision !== item.revision + 1 || response.draft_revision !== draft.revision + 1 ||
        returnedFingerprint !== fingerprint) throw new ApiError(409, 'Writing context changed. Refresh saved data before checking again.')
      current.current = null; setBusy(false); reconciled(); store.acceptDraft(response.draft)
    } catch (failure) {
      if (current.current === pending) {
        const problem = failure instanceof ApiError ? failure : new ApiError(0, 'Could not check. Your writing is retained.')
        setError(problem)
        if (pending.sent && [0, 404, 409, 500].includes(problem.status)) { uncertain.current = true; setNeedsRefresh(true) }
      }
    } finally { if (current.current === pending) { current.current = null; setBusy(false) } }
  }
  return { error, busy, needsRefresh, get, invalidate, reconciled }
}
