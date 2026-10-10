import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlan } from './usePlan'
import { SentenceStore } from '../autosave/SentenceStore'
import { api, ApiError } from '../api/writing'
import { hintsFingerprint } from '../api/hintsContext'
import { item, sampleDraft } from '../test/fixtures'
import type { HelpLevel, PlanResponse } from '../types/writing'

const output = { slots: [{ role: 'subject' as const, content: 'supplied subject' }], gaps: [], ordering_suggestion: 'Subject then action.', matched_structures: [], matched_keywords: [], examples: [] }
const stores: SentenceStore[] = []
function setup(notes = 'Saved notes') {
  let saved = sampleDraft({ intentions: [{ ...item(1), user_notes: notes }, item(2, 1)], intention_count: 2 })
  const save = vi.fn(async (id: number, revision: number, text: string, _signal: AbortSignal, notes: string) => {
    const intention = saved.intentions.find(item => item.id === id)!
    Object.assign(intention, { revision: revision + 1, sentence_text: text || null, user_notes: notes || null }); saved.revision++
    return structuredClone(intention)
  })
  const store = new SentenceStore({ save, get: async () => structuredClone(saved) }, vi.fn()); stores.push(store); store.acceptDraft(structuredClone(saved))
  const plan = vi.spyOn(api, 'plan').mockImplementation(async (id, level, _notes, revision, draftRevision) => ({ result: output, context_fingerprint: await hintsFingerprint(store.getSnapshot().draft!, id, level, 'make_plan'), intention_revision: revision, draft_revision: draftRevision, intention: structuredClone(saved.intentions.find(item => item.id === id)!), mode: 'fake' }))
  const hook = renderHook(({ id, level }: { id: number; level: HelpLevel }) => usePlan(store, id, level), { initialProps: { id: 1, level: 'hint' as HelpLevel } })
  return { ...hook, store, save, plan }
}
function deferred() { let resolve!: (value: PlanResponse) => void; const promise = new Promise<PlanResponse>(done => { resolve = done }); return { resolve, promise } }
beforeEach(() => localStorage.clear())
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks() })

describe('plan requests and notes freshness', () => {
  it('flushes both fields and all intentions before sending notes against latest revisions', async () => {
    const f = setup(); act(() => { f.store.edit(1, 'My sentence'); f.store.editNotes(1, '中文 ideas'); f.store.editNotes(2, 'Other notes') })
    await act(() => f.result.current.get())
    expect(f.save).toHaveBeenCalledTimes(2); expect(f.plan).toHaveBeenCalledWith(1, 'hint', '中文 ideas', 2, 3, expect.any(AbortSignal))
    expect(f.result.current.result?.result.slots).toHaveLength(1); expect(localStorage.length).toBe(0)
  })
  it('blank notes do not call the model', async () => {
    const f = setup(' \n\u0085'); await act(() => f.result.current.get())
    expect(f.plan).not.toHaveBeenCalled(); expect(f.result.current.error?.status).toBe(422)
  })
  it('failed autosave blocks planning and keeps a paired recovery copy', async () => {
    const f = setup(); f.save.mockRejectedValueOnce(new ApiError(0, 'Offline'))
    act(() => f.store.editNotes(1, 'Local notes')); await act(() => f.result.current.get())
    expect(f.plan).not.toHaveBeenCalled(); expect(f.store.getSnapshot().buffers[1].notes).toBe('Local notes'); expect(localStorage.length).toBe(1)
  })
  it('a planning error preserves saved notes and the writer sentence without retrying', async () => {
    const f = setup(); act(() => { f.store.edit(1, 'Keep my sentence'); f.store.editNotes(1, 'Keep notes') })
    f.plan.mockRejectedValueOnce(new ApiError(502, 'Invalid plan.')); await act(() => f.result.current.get())
    expect(f.plan).toHaveBeenCalledTimes(1); expect(f.result.current.error?.message).toBe('Invalid plan.')
    expect(f.store.getSnapshot().buffers[1]).toMatchObject({ text: 'Keep my sentence', notes: 'Keep notes', state: 'Saved' })
  })
  it('notes edited while planning abort guidance and ignore a late success', async () => {
    const f = setup(), pending = deferred(); f.plan.mockReturnValueOnce(pending.promise)
    let get!: Promise<void>; act(() => { get = f.result.current.get() }); await waitFor(() => expect(f.plan).toHaveBeenCalled())
    act(() => f.store.editNotes(1, 'Newer notes')); expect(f.plan.mock.calls[0][5]?.aborted).toBe(true)
    await act(async () => { pending.resolve({ result: output, context_fingerprint: 'a'.repeat(64), intention_revision: 1, draft_revision: 1, intention: item(1), mode: 'fake' }); await get })
    expect(f.result.current.result).toBeNull(); expect(f.result.current.error).toBeNull()
  })
  it.each(['level', 'selection'] as const)('changing %s aborts pending plan without making another request', async change => {
    const f = setup(), pending = deferred(); f.plan.mockReturnValueOnce(pending.promise)
    let get!: Promise<void>; act(() => { get = f.result.current.get() }); await waitFor(() => expect(f.plan).toHaveBeenCalled())
    f.rerender(change === 'level' ? { id: 1, level: 'structure' } : { id: 2, level: 'hint' }); expect(f.plan.mock.calls[0][5]?.aborted).toBe(true)
    await act(async () => { pending.resolve({ result: output, context_fingerprint: 'a'.repeat(64), intention_revision: 1, draft_revision: 1, intention: item(1), mode: 'fake' }); await get })
    expect(f.result.current.result).toBeNull(); expect(f.plan).toHaveBeenCalledTimes(1)
  })
  it('rejects a hints fingerprint for a plan even if the writing revisions match', async () => {
    const f = setup(); f.plan.mockImplementationOnce(async () => ({ result: output, context_fingerprint: await hintsFingerprint(f.store.getSnapshot().draft!, 1, 'hint'), intention_revision: 1, draft_revision: 1, intention: item(1), mode: 'fake' }))
    await act(() => f.result.current.get()); expect(f.result.current.result).toBeNull(); expect(f.result.current.error?.status).toBe(409)
  })
  it('duplicate clicks produce one plan call and lowering the help level clears the displayed plan', async () => {
    const f = setup(); await act(async () => { const get = f.result.current.get(); await f.result.current.get(); await get })
    expect(f.plan).toHaveBeenCalledTimes(1); expect(f.result.current.result).not.toBeNull()
    f.rerender({ id: 1, level: 'structure' }); expect(f.result.current.result).toBeNull(); expect(f.plan).toHaveBeenCalledTimes(1)
  })
})
