import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../api/writing'
import { SentenceStore } from '../autosave/SentenceStore'
import type { Draft } from '../types/writing'

export function useSentenceAutosave(id: number, draft: Draft | null, onDraft: (draft: Draft) => void) {
  const [store] = useState(() => new SentenceStore({ save: (itemId, revision, text, signal, notes) => api.saveWriting(itemId, revision, text, notes, signal), get: signal => api.get(id, signal) }, onDraft))
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => { store.mount(); return () => store.dispose() }, [store])
  useEffect(() => { if (draft) store.acceptDraft(draft) }, [draft, store])
  return { store, snapshot }
}
