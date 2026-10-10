import type { Draft, HelpLevel } from '../types/writing'

export function hintsContext(draft: Draft, intentionId: number, helpLevel: HelpLevel) {
  const current = draft.intentions.find(item => item.id === intentionId)
  if (!current) throw new Error('The selected intention was removed.')
  return {
    topic: draft.topic, task_description: draft.task_description,
    target_sentence_count: draft.target_sentence_count, target_word_min: draft.target_word_min, target_word_max: draft.target_word_max,
    intentions: draft.intentions.map(item => ({ function_label: item.function_label, description: item.description })),
    current_intention: { position: current.position, function_label: current.function_label, description: current.description, guiding_question: current.guiding_question },
    previous_sentences: draft.intentions.filter(item => item.position < current.position && item.sentence_text).map(item => item.sentence_text),
    current_sentence: current.sentence_text ?? '', user_notes: current.user_notes ?? '', help_level: helpLevel,
  }
}
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
export async function hintsFingerprint(draft: Draft, id: number, level: HelpLevel, task: 'get_hints' | 'make_plan' = 'get_hints') {
  const bytes = new TextEncoder().encode(canonicalJSON({ task, input: hintsContext(draft, id, level) }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function checkFingerprint(draft: Draft, id: number) {
  const context: Partial<ReturnType<typeof hintsContext>> = hintsContext(draft, id, 'hint')
  delete context.help_level
  const bytes = new TextEncoder().encode(canonicalJSON({ task: 'check_sentence', input: context }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
