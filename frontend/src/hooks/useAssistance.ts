import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/writing'
import { hintsFingerprint } from '../api/hintsContext'
import { normalizedSentence } from '../autosave/SentenceStore'
import type { SentenceStore } from '../autosave/SentenceStore'
import type { Draft, HelpLevel, HintsResponse, PlanResponse } from '../types/writing'

export function useAssistance<T extends HintsResponse | PlanResponse>(store: SentenceStore, id: number | undefined, level: HelpLevel, task: 'get_hints' | 'make_plan', request: (draft: Draft, id: number, level: HelpLevel, signal: AbortSignal) => Promise<T>) {
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const current = useRef<{ controller: AbortController; serial: number; epoch?: number } | null>(null)
  const serial = useRef(0)
  const displayedEpoch = useRef<number | null>(null)
  const invalidate = useCallback(() => { serial.current++; current.current?.controller.abort(); current.current = null; displayedEpoch.current = null; setBusy(false); setResult(null); setError(null) }, [])
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      const epoch = store.getSnapshot().epoch
      if (current.current?.epoch !== undefined && current.current.epoch !== epoch || displayedEpoch.current !== null && displayedEpoch.current !== epoch) invalidate()
    })
    return () => { unsubscribe(); current.current?.controller.abort(); current.current = null; serial.current++ }
  }, [store, invalidate])
  useEffect(() => { invalidate() }, [id, level, invalidate])
  async function get() {
    if (current.current || id === undefined) return
    const pending = { controller: new AbortController(), serial: ++serial.current, epoch: undefined as number | undefined }
    current.current = pending; setBusy(true); setResult(null); setError(null)
    try {
      if (!await store.flush()) throw new ApiError(422, 'Save or resolve pending sentence or notes edits before requesting guidance.')
      if (current.current !== pending) return
      const snapshot = store.getSnapshot(), draft = snapshot.draft
      const item = draft?.intentions.find(item => item.id === id)
      if (!draft || !item) throw new ApiError(404, 'The selected intention was removed.')
      pending.epoch = snapshot.epoch
      if (task === 'make_plan' && !normalizedSentence(item.user_notes ?? '')) throw new ApiError(422, 'Add rough notes before making a sentence plan.')
      const expected = await hintsFingerprint(draft, id, level, task)
      if (current.current !== pending) return
      const response = await request(draft, id, level, pending.controller.signal)
      if (current.current !== pending || store.getSnapshot().epoch !== pending.epoch) return
      if (response.context_fingerprint !== expected || response.intention_revision !== item.revision || response.draft_revision !== draft.revision) throw new ApiError(409, 'Writing context changed. Refresh saved data before requesting guidance again.')
      displayedEpoch.current = pending.epoch
      setResult(response)
    } catch (failure) {
      if (current.current === pending) setError(failure instanceof ApiError ? failure : new ApiError(0, 'Could not get guidance. Your sentence and notes are retained.'))
    } finally {
      if (current.current === pending) { current.current = null; setBusy(false) }
    }
  }
  return { result, error, busy, get, invalidate }
}
