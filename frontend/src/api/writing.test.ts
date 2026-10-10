import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, request } from './writing'
import { item, jsonResponse, sampleDraft } from '../test/fixtures'
import type { CheckResponse } from '../types/writing'

function checkResponse(): CheckResponse {
  const result = { fulfils_intention: 'yes' as const, summary: 'Purpose achieved.', issues: [] }
  const intention = { ...item(1), status: 'checked' as const, revision: 2, sentence_text: 'Sentence.', last_check_fingerprint: 'a'.repeat(64), last_check_json: { result, mode: 'fake' as const } }
  return { result, intention, draft: sampleDraft({ revision: 2, intentions: [intention], intention_count: 1 }), context_fingerprint: 'a'.repeat(64), intention_revision: 2, draft_revision: 2, mode: 'fake' }
}

afterEach(() => vi.useRealTimers())
describe('API contracts and request safety', () => {
  it('checks exact text against both revisions and validates the persisted draft/envelope', async () => {
    const response = checkResponse(), fetchMock = vi.fn().mockResolvedValue(jsonResponse(response))
    vi.stubGlobal('fetch', fetchMock)
    expect(await api.check(1, 'Sentence.', 1, 1)).toEqual(response)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sentence: 'Sentence.', expected_revision: 1, expected_draft_revision: 1 })
  })
  it.each(['unsafe revision', 'bad verdict', 'bad issue', 'cap', 'rewrite', 'wrong mode', 'wrong draft', 'wrong text', 'wrong fingerprint', 'missing saved feedback'])('rejects inconsistent check responses: %s', async reason => {
    const response = checkResponse()
    if (reason === 'unsafe revision') response.intention_revision = 2 ** 53
    if (reason === 'bad verdict') Object.assign(response.result, { fulfils_intention: 'maybe' })
    if (reason === 'bad issue') Object.assign(response.result, { issues: [{ type: 'grammar', message: 'Message', suggestion: 'Suggestion' }] })
    if (reason === 'cap') response.result.issues = Array.from({ length: 6 }, () => ({ type: 'other', message: 'Message', suggestion: 'Suggestion' }))
    if (reason === 'rewrite') Object.assign(response.result, { rewrite: 'Unwanted rewrite.' })
    if (reason === 'wrong mode') response.mode = 'live'
    if (reason === 'wrong draft') response.draft.revision = 99
    if (reason === 'wrong text') response.intention.sentence_text = 'Different.'
    if (reason === 'wrong fingerprint') response.context_fingerprint = 'b'.repeat(64)
    if (reason === 'missing saved feedback') Object.assign(response.intention, { last_check_json: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)))
    await expect(api.check(1, 'Sentence.', 1, 1)).rejects.toMatchObject({ status: 0 })
  })
  it('check waits up to 70 seconds and never replays a timed out mutation', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    vi.stubGlobal('fetch', fetchMock)
    const pending = api.check(1, 'Sentence.', 1, 1).catch(error => error)
    await vi.advanceTimersByTimeAsync(69_999); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toMatchObject({ status: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('saves a paired buffer and submits saved notes with both plan revisions', async () => {
    const notes = '中文 ideas'
    const result = { slots: [], gaps: [], ordering_suggestion: 'Subject then action.', matched_structures: [], matched_keywords: [], examples: [] }
    const intention = { ...item(1), revision: 4, sentence_text: 'My sentence.', user_notes: notes }
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(intention)).mockResolvedValueOnce(jsonResponse({ result, intention, intention_revision: 4, draft_revision: 9, context_fingerprint: 'a'.repeat(64), mode: 'fake' }))
    vi.stubGlobal('fetch', fetchMock)
    await api.saveWriting(1, 3, 'My sentence.', notes); await api.plan(1, 'hint', notes, 4, 9)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sentence_text: 'My sentence.', user_notes: notes, expected_revision: 3 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ user_notes: notes, help_level: 'hint', expected_revision: 4, expected_draft_revision: 9 })
  })
  it.each(['unsafe revision', 'bad role', 'bad list', 'structure leak', 'example leak', 'cap', 'wrong notes'])('rejects incompatible plan responses: %s', async reason => {
    const result = { slots: [] as unknown[], gaps: [] as unknown[], ordering_suggestion: 'Subject then action.', matched_structures: [] as unknown[], matched_keywords: [], examples: [] as unknown[] }
    const response = { result, intention: { ...item(1), user_notes: 'Notes' }, intention_revision: 1, draft_revision: 1, context_fingerprint: 'a'.repeat(64), mode: 'fake' }
    if (reason === 'unsafe revision') response.draft_revision = 2 ** 53
    if (reason === 'bad role') result.slots = [{ role: 'wrong', content: 'Word' }]
    if (reason === 'bad list') result.gaps = [null]
    if (reason === 'structure leak') result.matched_structures = [{ pattern: '[subject] acts.', note: 'Pattern' }]
    if (reason === 'example leak') result.examples = [{ sentence: 'Example.', why_it_works: 'Reason' }]
    if (reason === 'cap') result.slots = Array.from({ length: 7 }, () => ({ role: 'subject', content: 'Subject' }))
    if (reason === 'wrong notes') response.intention.user_notes = 'Other notes'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)))
    await expect(api.plan(1, 'hint', 'Notes', 1, 1)).rejects.toMatchObject({ status: 0 })
  })
  it('saves only sentence text and sends both revisions for hints', async () => {
    const response = { result: { intention_summary: 'Purpose', relationship: 'First', entities: [], keywords: [], connectives: [], structures: [], examples: [] }, context_fingerprint: 'a'.repeat(64), intention_revision: 4, draft_revision: 9, mode: 'fake' }
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ...item(1), revision: 4 })).mockResolvedValueOnce(jsonResponse(response)); vi.stubGlobal('fetch', fetchMock)
    await api.saveSentence(1, 3, 'My sentence.'); await api.hints(1, 'hint', 4, 9)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sentence_text: 'My sentence.', expected_revision: 3 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ help_level: 'hint', expected_revision: 4, expected_draft_revision: 9 })
  })
  it.each(['unsafe revision', 'malformed list', 'disallowed structure', 'disallowed example', 'over cap'])('rejects incompatible hints: %s', async reason => {
    const result = { intention_summary: 'Purpose', relationship: 'First', entities: [] as unknown[], keywords: [] as unknown[], connectives: [], structures: [] as unknown[], examples: [] as unknown[] }
    const response = { result, context_fingerprint: 'a'.repeat(64), intention_revision: 4, draft_revision: 9, mode: 'fake' }
    if (reason === 'unsafe revision') response.draft_revision = 2 ** 53
    if (reason === 'malformed list') result.entities = [null]
    if (reason === 'disallowed structure') result.structures = [{ pattern: '[Subject] acts.', note: 'Pattern' }]
    if (reason === 'disallowed example') result.examples = [{ sentence: 'Complete example.', why_it_works: 'Reason' }]
    if (reason === 'over cap') result.keywords = Array.from({ length: 7 }, () => ({ phrase: 'word', note: 'Note' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)))
    await expect(api.hints(1, 'hint', 4, 9)).rejects.toMatchObject({ status: 0 })
  })
  it('sends saved revisions and explicit replacement confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...sampleDraft({ revision: 8 }), mode: 'fake' }))
    vi.stubGlobal('fetch', fetchMock)
    await api.generate(sampleDraft({ revision: 7 }), true)
    expect(fetchMock).toHaveBeenCalledWith('/api/drafts/1/intentions/generate', expect.objectContaining({ method: 'POST', body: JSON.stringify({ mode: 'replace', expected_revision: 7, confirm_replace: true }) }))
  })
  it('accepts 204 without parsing JSON and supplies deletion revisions', async () => {
    const response = jsonResponse(null, 204)
    const parser = vi.spyOn(response, 'json')
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    await api.deleteDraft(sampleDraft({ revision: 4 }))
    expect(fetchMock).toHaveBeenCalledWith('/api/drafts/1?expected_revision=4', expect.objectContaining({ method: 'DELETE' }))
    expect(parser).not.toHaveBeenCalled()
  })
  it('returns readable server detail with status and rejects unsafe identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ detail: 'Draft changed.' }, 409)).mockResolvedValueOnce(jsonResponse(sampleDraft({ id: 2 ** 53 }))))
    await expect(api.get(1)).rejects.toMatchObject({ status: 409, message: 'Draft changed.' })
    await expect(api.get(1)).rejects.toMatchObject({ status: 0, message: expect.stringContaining('browser range') })
  })
  it('rejects incompatible successful responses before the UI renders them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ status: 'ok' })).mockResolvedValueOnce(jsonResponse({ ...sampleDraft(), intentions: null })).mockResolvedValueOnce(jsonResponse({ ...sampleDraft(), last_generation_mode: 'unknown' })))
    await expect(api.list()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('incompatible writing response') })
    await expect(api.get(1)).rejects.toMatchObject({ status: 0 })
    await expect(api.get(1)).rejects.toMatchObject({ status: 0 })
  })
  it('bounds generation to 70 seconds without retrying', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    vi.stubGlobal('fetch', fetchMock)
    const pending = api.generate(sampleDraft(), false).catch(error => error)
    await vi.advanceTimersByTimeAsync(69_999)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ status: 0, message: expect.stringContaining('server may still finish') })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('passes cancellation through and bounds ordinary reads', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    vi.stubGlobal('fetch', fetchMock)
    const pending = api.get(1).catch(error => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ status: 0 })
    const controller = new AbortController()
    const canceled = request('/api/drafts', 'GET', undefined, controller.signal).catch(error => error)
    controller.abort()
    expect(await canceled).toMatchObject({ status: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
