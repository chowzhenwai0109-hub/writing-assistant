import type { CheckOutput, CheckResponse, Draft, DraftInput, DraftSummary, Generation, HelpLevel, HintsResponse, Intention, IntentionInput, PlanResponse } from '../types/writing'
import { canonicalJSON } from './hintsContext'

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

// Never round a SQLite ID/revision and accidentally mutate a different record.
function checkIdentifiers(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(checkIdentifiers); return }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (['id', 'draft_id', 'revision'].includes(key) && (!Number.isSafeInteger(item) || Number(item) < 1)) {
      throw new ApiError(0, 'A record identifier exceeds the supported browser range. This browser cannot safely edit that record.')
    }
    if (key !== 'last_check_json') checkIdentifiers(item)
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) incompatible()
  return value as Record<string, unknown>
}
function incompatible(): never { throw new ApiError(0, 'The backend returned an incompatible writing response. Refresh saved data before trying again.') }
const nullableText = (value: unknown) => value === null || typeof value === 'string'
const nullableNumber = (value: unknown) => value === null || typeof value === 'number'
function checkOutput(value: unknown): CheckOutput {
  const data = object(value)
  const text = (v: unknown) => typeof v === 'string' && !!v.trim() && Array.from(v).length <= 1000
  if (Object.keys(data).sort().join() !== 'fulfils_intention,issues,summary' ||
    !['yes', 'partly', 'no'].includes(String(data.fulfils_intention)) || !text(data.summary) ||
    !Array.isArray(data.issues) || data.issues.length > 5) incompatible()
  for (const raw of data.issues) {
    const issue = object(raw)
    if (Object.keys(issue).sort().join() !== 'message,suggestion,type' ||
      !['off_intention', 'overclaim', 'missing_info', 'repetition', 'unclear_relation', 'unestablished_info', 'other'].includes(String(issue.type)) ||
      !text(issue.message) || !text(issue.suggestion)) incompatible()
  }
  return value as CheckOutput
}
function summary(value: unknown): DraftSummary {
  const data = object(value)
  if (!['title', 'topic', 'task_description', 'created_at', 'updated_at'].every(key => typeof data[key] === 'string') ||
    !['id', 'revision', 'intention_count', 'target_sentence_count'].every(key => Number.isSafeInteger(data[key])) ||
    !nullableNumber(data.target_word_min) || !nullableNumber(data.target_word_max) ||
    ![null, 'fake', 'live'].includes(data.last_generation_mode as null | string)) incompatible()
  return value as DraftSummary
}
function intention(value: unknown): Intention {
  const data = object(value)
  if (!['function_label', 'description', 'guiding_question'].every(key => typeof data[key] === 'string') ||
    !['id', 'draft_id', 'revision', 'position'].every(key => Number.isSafeInteger(data[key])) ||
    !['pending', 'written', 'checked'].includes(String(data.status)) ||
    !nullableText(data.sentence_text) || !nullableText(data.user_notes) || !nullableText(data.last_check_fingerprint) ||
    !(data.last_check_json === null || typeof data.last_check_json === 'object' && !Array.isArray(data.last_check_json))) incompatible()
  if (data.last_check_json !== null) {
    const saved = object(data.last_check_json)
    if (Object.keys(saved).sort().join() !== 'mode,result' || !['fake', 'live'].includes(String(saved.mode)) ||
      data.status !== 'checked' || typeof data.last_check_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(data.last_check_fingerprint)) incompatible()
    checkOutput(saved.result)
  } else if (data.status === 'checked' || data.last_check_fingerprint !== null) incompatible()
  return value as Intention
}
function fullDraft(value: unknown): Draft {
  summary(value)
  const data = object(value)
  if (!Array.isArray(data.intentions)) incompatible()
  data.intentions.forEach(intention)
  return value as Draft
}

export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = window.setTimeout(abort, /\/(generate|hints|plan|check)$/.test(path) ? 70_000 : 15_000)
  try {
    const response = await fetch(path, {
      method, signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (response.status === 204 && response.ok) return undefined as T
    let data: unknown
    try { data = await response.json() } catch { throw new ApiError(response.ok ? 0 : response.status, 'The backend returned an unreadable response. Refresh saved data before trying again.') }
    if (!response.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data && typeof data.detail === 'string' ? data.detail : 'The request failed. Please try again.'
      throw new ApiError(response.status, detail)
    }
    if (data === null || typeof data !== 'object') throw new ApiError(0, 'The backend returned an unexpected response. Refresh saved data before trying again.')
    checkIdentifiers(data)
    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(0, controller.signal.aborted
      ? 'The request timed out or was canceled. Refresh saved data before trying again; the server may still finish it.'
      : 'Could not connect to the backend. Refresh saved data before trying again.')
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export const api = {
  check: (id: number, sentence: string, revision: number, draftRevision: number, signal?: AbortSignal) => request<CheckResponse>(`/api/intentions/${id}/check`, 'POST', { sentence, expected_revision: revision, expected_draft_revision: draftRevision }, signal).then(value => {
    checkOutput(value.result); intention(value.intention); fullDraft(value.draft)
    if (!['fake', 'live'].includes(value.mode) || !Number.isSafeInteger(value.intention_revision) || !Number.isSafeInteger(value.draft_revision) ||
      typeof value.context_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.context_fingerprint) ||
      value.intention.id !== id || value.intention.revision !== value.intention_revision || value.intention.sentence_text !== sentence ||
      value.draft.revision !== value.draft_revision || value.draft.id !== value.intention.draft_id ||
      canonicalJSON(value.draft.intentions.find(item => item.id === id)) !== canonicalJSON(value.intention) ||
      value.intention.last_check_fingerprint !== value.context_fingerprint || value.intention.last_check_json?.mode !== value.mode ||
      canonicalJSON(value.intention.last_check_json?.result) !== canonicalJSON(value.result)) incompatible()
    return value
  }),
  list: (signal?: AbortSignal) => request<DraftSummary[]>('/api/drafts', 'GET', undefined, signal).then(value => { if (!Array.isArray(value)) incompatible(); return value.map(summary) }),
  get: (id: number, signal?: AbortSignal) => request<Draft>(`/api/drafts/${id}`, 'GET', undefined, signal).then(fullDraft),
  create: (body: DraftInput, signal?: AbortSignal) => request<DraftSummary>('/api/drafts', 'POST', body, signal).then(summary),
  settings: (draft: Draft, body: DraftInput, signal?: AbortSignal) => request<DraftSummary>(`/api/drafts/${draft.id}`, 'PATCH', { ...body, expected_revision: draft.revision }, signal).then(summary),
  deleteDraft: (draft: DraftSummary, signal?: AbortSignal) => request<void>(`/api/drafts/${draft.id}?expected_revision=${draft.revision}`, 'DELETE', undefined, signal),
  generate: (draft: Draft, confirmed: boolean, signal?: AbortSignal) => request<Generation>(`/api/drafts/${draft.id}/intentions/generate`, 'POST', { mode: 'replace', expected_revision: draft.revision, confirm_replace: confirmed }, signal).then(value => { fullDraft(value); if (!['fake', 'live'].includes(value.mode)) incompatible(); return value }),
  add: (draft: Draft, body: IntentionInput, signal?: AbortSignal) => request<Intention>(`/api/drafts/${draft.id}/intentions`, 'POST', { ...body, expected_draft_revision: draft.revision }, signal).then(intention),
  edit: (item: Intention, body: IntentionInput, signal?: AbortSignal) => request<Intention>(`/api/intentions/${item.id}`, 'PATCH', { ...body, expected_revision: item.revision }, signal).then(intention),
  deleteIntention: (draft: Draft, item: Intention, signal?: AbortSignal) => request<void>(`/api/intentions/${item.id}?expected_revision=${item.revision}&expected_draft_revision=${draft.revision}`, 'DELETE', undefined, signal),
  order: (draft: Draft, ids: number[], signal?: AbortSignal) => request<Draft>(`/api/drafts/${draft.id}/intentions/order`, 'PUT', { ordered_ids: ids, expected_revision: draft.revision }, signal).then(fullDraft),
  saveSentence: (id: number, revision: number, text: string, signal?: AbortSignal) => request<Intention>(`/api/intentions/${id}`, 'PATCH', { sentence_text: text, expected_revision: revision }, signal).then(intention),
  saveWriting: (id: number, revision: number, text: string, notes: string, signal?: AbortSignal) => request<Intention>(`/api/intentions/${id}`, 'PATCH', { sentence_text: text, user_notes: notes, expected_revision: revision }, signal).then(intention),
  plan: (id: number, level: HelpLevel, notes: string, revision: number, draftRevision: number, signal?: AbortSignal) => request<PlanResponse>(`/api/intentions/${id}/plan`, 'POST', { user_notes: notes, help_level: level, expected_revision: revision, expected_draft_revision: draftRevision }, signal).then(value => {
    const data = object(value), result = object(data.result)
    if (typeof data.context_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(data.context_fingerprint) ||
      !Number.isSafeInteger(data.intention_revision) || Number(data.intention_revision) < 1 || !Number.isSafeInteger(data.draft_revision) || Number(data.draft_revision) < 1 ||
      !['fake', 'live'].includes(String(data.mode)) || typeof result.ordering_suggestion !== 'string') incompatible()
    for (const [field, keys, cap] of [['slots', ['role', 'content'], 6], ['gaps', ['missing', 'question'], 5], ['matched_structures', ['pattern', 'note'], 3], ['matched_keywords', ['phrase', 'note'], 6], ['examples', ['sentence', 'why_it_works'], 2]] as const) {
      if (!Array.isArray(result[field]) || result[field].length > cap || result[field].some((item: unknown) => !keys.every(key => typeof object(item)[key] === 'string'))) incompatible()
    }
    if (value.result.slots.some(slot => !['subject', 'action', 'condition', 'consequence', 'detail', 'other'].includes(slot.role)) ||
      level === 'hint' && value.result.matched_structures.length || level !== 'example' && value.result.examples.length) incompatible()
    intention(value.intention)
    if (value.intention.id !== id || value.intention.revision !== value.intention_revision || value.intention.user_notes !== notes) incompatible()
    return value
  }),
  hints: (id: number, level: HelpLevel, revision: number, draftRevision: number, signal?: AbortSignal) => request<HintsResponse>(`/api/intentions/${id}/hints`, 'POST', { help_level: level, expected_revision: revision, expected_draft_revision: draftRevision }, signal).then(value => {
    const data = object(value), result = object(data.result)
    if (typeof data.context_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(data.context_fingerprint) ||
      !Number.isSafeInteger(data.intention_revision) || Number(data.intention_revision) < 1 || !Number.isSafeInteger(data.draft_revision) || Number(data.draft_revision) < 1 ||
      !['fake', 'live'].includes(String(data.mode)) || typeof result.intention_summary !== 'string' || typeof result.relationship !== 'string') incompatible()
    for (const [field, keys, cap] of [['entities', ['label', 'why_needed'], 5], ['keywords', ['phrase', 'note'], 6], ['connectives', ['word', 'use'], 4], ['structures', ['pattern', 'note'], 3], ['examples', ['sentence', 'why_it_works'], 2]] as const) {
      if (!Array.isArray(result[field]) || result[field].length > cap || result[field].some((item: unknown) => !keys.every(key => typeof object(item)[key] === 'string'))) incompatible()
    }
    if (level === 'hint' && value.result.structures.length || level !== 'example' && value.result.examples.length) incompatible()
    return value
  }),
}
