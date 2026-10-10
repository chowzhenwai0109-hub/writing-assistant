import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCheck } from './useCheck'
import { SentenceStore } from '../autosave/SentenceStore'
import { api, ApiError } from '../api/writing'
import { checkFingerprint, hintsFingerprint } from '../api/hintsContext'
import { item, sampleDraft } from '../test/fixtures'
import type { CheckResponse } from '../types/writing'

const output = { fulfils_intention: 'partly' as const, summary: 'Review this claim.', issues: [{ type: 'overclaim' as const, message: 'Scope too broad.', suggestion: 'Limit the scope.' }] }
const stores: SentenceStore[] = []
function setup(sentence = 'My saved sentence.') {
  let saved = sampleDraft({ intentions: [{ ...item(1), status: 'written', sentence_text: sentence, user_notes: 'Notes' }, item(2, 1)], intention_count: 2 })
  const save = vi.fn(async (id: number, revision: number, text: string, _signal: AbortSignal, notes: string) => {
    const intention = saved.intentions.find(item => item.id === id)!
    Object.assign(intention, { revision: revision + 1, sentence_text: text || null, user_notes: notes || null }); saved.revision++
    return structuredClone(intention)
  })
  const store = new SentenceStore({ save, get: async () => structuredClone(saved) }, vi.fn()); stores.push(store); store.acceptDraft(structuredClone(saved))
  async function response(id = 1): Promise<CheckResponse> {
    const fingerprint = await checkFingerprint(saved, id), intention = saved.intentions.find(item => item.id === id)!
    Object.assign(intention, { status: 'checked', last_check_json: { result: output, mode: 'fake' }, last_check_fingerprint: fingerprint, revision: intention.revision + 1 }); saved.revision++
    return { result: output, context_fingerprint: fingerprint, intention_revision: intention.revision, draft_revision: saved.revision, mode: 'fake', intention: structuredClone(intention), draft: structuredClone(saved) }
  }
  const check = vi.spyOn(api, 'check').mockImplementation(id => response(id))
  const hook = renderHook(({ id }) => useCheck(store, id), { initialProps: { id: 1 } })
  return { ...hook, store, save, check, response }
}
function deferred() { let resolve!: (value: CheckResponse) => void; const promise = new Promise<CheckResponse>(done => { resolve = done }); return { resolve, promise } }
beforeEach(() => localStorage.clear())
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks() })

describe('check lifecycle', () => {
  it('flushes all paired writing, adopts persisted feedback and acknowledges its new revision', async () => {
    const f = setup(); act(() => { f.store.edit(1, 'New sentence'); f.store.editNotes(1, 'New notes'); f.store.editNotes(2, 'Other notes') })
    await act(() => f.result.current.get())
    expect(f.save).toHaveBeenCalledTimes(2); expect(f.check).toHaveBeenCalledWith(1, 'New sentence', 2, 3, expect.any(AbortSignal))
    expect(f.store.getSnapshot().draft?.revision).toBe(4)
    expect(f.store.getSnapshot().buffers[1]).toMatchObject({ text: 'New sentence', notes: 'New notes', revision: 3, state: 'Saved', problem: null })
    expect(f.store.getSnapshot().draft?.intentions[0]).toMatchObject({ status: 'checked', last_check_json: { result: output, mode: 'fake' } })
    expect(localStorage.length).toBe(0)
  })
  it('blank writing never calls check', async () => {
    const f = setup(' \n\u0085'); await act(() => f.result.current.get())
    expect(f.check).not.toHaveBeenCalled(); expect(f.result.current.error?.status).toBe(422)
  })
  it('failed autosave blocks check and retains recovery', async () => {
    const f = setup(); f.save.mockRejectedValueOnce(new ApiError(0, 'Offline'))
    act(() => f.store.edit(1, 'Unsaved')); await act(() => f.result.current.get())
    expect(f.check).not.toHaveBeenCalled(); expect(localStorage.length).toBe(1)
  })
  it('model failure does not replay a check or change saved writing', async () => {
    const f = setup(); f.check.mockRejectedValueOnce(new ApiError(502, 'Invalid result'))
    await act(() => f.result.current.get()); expect(f.check).toHaveBeenCalledTimes(1)
    expect(f.result.current.error?.status).toBe(502); expect(f.result.current.needsRefresh).toBe(false)
    expect(f.store.getSnapshot().buffers[1].text).toBe('My saved sentence.')
  })
  it('unknown outcome blocks another check until saved data is read', async () => {
    const f = setup(); let committed!: CheckResponse
    f.check.mockImplementationOnce(async () => { committed = await f.response(); throw new ApiError(0, 'Lost reply') })
    await act(() => f.result.current.get()); expect(f.result.current.needsRefresh).toBe(true)
    await act(() => f.result.current.get()); expect(f.check).toHaveBeenCalledTimes(1)
    act(() => { f.store.acceptDraft(committed.draft); f.result.current.reconciled() })
    expect(f.result.current.needsRefresh).toBe(false); expect(f.store.getSnapshot().draft?.intentions[0].status).toBe('checked')
    expect(f.check).toHaveBeenCalledTimes(1)
  })
  it.each(['sentence', 'notes', 'selection'] as const)('changing %s aborts and suppresses a late check while retaining newer writing', async change => {
    const f = setup(), pending = deferred(); f.check.mockReturnValueOnce(pending.promise)
    let get!: Promise<void>; act(() => { get = f.result.current.get() }); await waitFor(() => expect(f.check).toHaveBeenCalled())
    const response = await f.response()
    if (change === 'selection') f.rerender({ id: 2 })
    else act(() => change === 'notes' ? f.store.editNotes(1, 'Newer notes') : f.store.edit(1, 'Newer sentence'))
    expect(f.check.mock.calls[0][4]?.aborted).toBe(true); expect(f.result.current.needsRefresh).toBe(true)
    await act(async () => { pending.resolve(response); await get })
    expect(f.store.getSnapshot().draft?.intentions[0].status).toBe('written')
    if (change !== 'selection') expect(f.store.getSnapshot().buffers[1][change === 'notes' ? 'notes' : 'text']).toBe(`Newer ${change}`)
  })
  it('duplicate clicks issue one request', async () => {
    const f = setup(); await act(async () => { const get = f.result.current.get(); await f.result.current.get(); await get })
    expect(f.check).toHaveBeenCalledTimes(1); expect(f.result.current.busy).toBe(false)
  })
  it('rejects a hints fingerprint or wrong revisions before adopting feedback', async () => {
    const f = setup(); f.check.mockImplementationOnce(async () => { const response = await f.response(); response.context_fingerprint = await hintsFingerprint(response.draft, 1, 'hint'); return response })
    await act(() => f.result.current.get()); expect(f.result.current.error?.status).toBe(409)
    expect(f.result.current.needsRefresh).toBe(true); expect(f.store.getSnapshot().draft?.intentions[0].status).toBe('written')
  })
})
