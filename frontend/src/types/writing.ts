export type Mode = 'fake' | 'live'
export type HelpLevel = 'hint' | 'structure' | 'example'
export type HintsOutput = {
  intention_summary: string; relationship: string
  entities: { label: string; why_needed: string }[]
  keywords: { phrase: string; note: string }[]
  connectives: { word: string; use: string }[]
  structures: { pattern: string; note: string }[]
  examples: { sentence: string; why_it_works: string }[]
}
export type HintsResponse = { result: HintsOutput; context_fingerprint: string; intention_revision: number; draft_revision: number; mode: Mode }
export type PlanOutput = {
  slots: { role: 'subject' | 'action' | 'condition' | 'consequence' | 'detail' | 'other'; content: string }[]
  gaps: { missing: string; question: string }[]
  ordering_suggestion: string
  matched_structures: { pattern: string; note: string }[]
  matched_keywords: { phrase: string; note: string }[]
  examples: { sentence: string; why_it_works: string }[]
}
export type PlanResponse = Omit<HintsResponse, 'result'> & { result: PlanOutput; intention: Intention }
export type CheckOutput = {
  fulfils_intention: 'yes' | 'partly' | 'no'
  summary: string
  issues: { type: 'off_intention' | 'overclaim' | 'missing_info' | 'repetition' | 'unclear_relation' | 'unestablished_info' | 'other'; message: string; suggestion: string }[]
}
export type SavedCheck = { result: CheckOutput; mode: Mode }
export type CheckResponse = Omit<HintsResponse, 'result'> & { result: CheckOutput; intention: Intention; draft: Draft }
export type DraftInput = {
  title: string
  topic: string
  task_description: string
  target_sentence_count: number
  target_word_min: number | null
  target_word_max: number | null
}
export type DraftSummary = DraftInput & {
  id: number
  revision: number
  created_at: string
  updated_at: string
  intention_count: number
  last_generation_mode: Mode | null
}
export type IntentionInput = { function_label: string; description: string; guiding_question: string }
export type Intention = IntentionInput & {
  id: number
  draft_id: number
  position: number
  revision: number
  status: 'pending' | 'written' | 'checked'
  sentence_text: string | null
  user_notes: string | null
  last_check_json: SavedCheck | null
  last_check_fingerprint: string | null
}
export type Draft = DraftSummary & { intentions: Intention[] }
export type Generation = Draft & { mode: Mode }
