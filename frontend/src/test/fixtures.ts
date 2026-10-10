import type { Draft, Intention } from '../types/writing'

export const item = (id: number, position = 0): Intention => ({ id, draft_id: 1, position, function_label: `Purpose ${id}`, description: 'Explain the point.', guiding_question: 'What should the reader understand?', revision: 1, status: 'pending', sentence_text: null, user_notes: null, last_check_json: null, last_check_fingerprint: null })
export const sampleDraft = (changes: Partial<Draft> = {}): Draft => ({ id: 1, title: 'My paragraph', topic: 'Software updates', task_description: '', target_sentence_count: 5, target_word_min: null, target_word_max: null, revision: 1, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', intention_count: 0, last_generation_mode: null, intentions: [], ...changes })
export const jsonResponse = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) })
