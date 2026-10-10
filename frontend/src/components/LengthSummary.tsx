import type { DraftInput, Draft } from '../types/writing'

export function countWords(text: string) { return text.trim() ? text.trim().split(/\s+/u).length : 0 }

export function LengthSummary({ settings, draft }: { settings: Pick<DraftInput, 'target_sentence_count' | 'target_word_min' | 'target_word_max'>; draft?: Draft }) {
  const { target_sentence_count: count, target_word_min: low, target_word_max: high } = settings
  const words = draft ? draft.intentions.reduce((sum, item) => sum + countWords(item.sentence_text ?? ''), 0) : null
  const bounded = low !== null && high !== null
  return <div className="length-summary">
    <p>{count} planned sentences{bounded ? ` · ${low}–${high} target words` : ' · No word target'}</p>
    {bounded && <p>Average planning range: {(low / count).toFixed(1)}–{(high / count).toFixed(1)} words per sentence.</p>}
    {bounded && (low / count > 40 || high / count < 8) && <p className="advisory">Length targets may be difficult for this sentence count.</p>}
    {draft && <>
      <p>{draft.intentions.length} intentions · {words} current words</p>
      {draft.intentions.length !== count && <p className="advisory">Your sequence has {draft.intentions.length} intentions; the plan calls for {count}. You can keep writing or adjust it.</p>}
      {bounded && (words! < low || words! > high) && <p className="advisory">Current words are {words! < low ? 'below' : 'above'} the target range. This is a guide, not a limit.</p>}
    </>}
  </div>
}
