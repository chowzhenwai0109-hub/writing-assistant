import { api } from '../api/writing'
import type { Draft, HelpLevel } from '../types/writing'
import type { SentenceStore } from '../autosave/SentenceStore'
import { useAssistance } from './useAssistance'

const request = (draft: Draft, id: number, level: HelpLevel, signal: AbortSignal) => {
  const item = draft.intentions.find(item => item.id === id)!
  return api.hints(id, level, item.revision, draft.revision, signal)
}
export function useHints(store: SentenceStore, id: number | undefined, level: HelpLevel) {
  return useAssistance(store, id, level, 'get_hints', request)
}
