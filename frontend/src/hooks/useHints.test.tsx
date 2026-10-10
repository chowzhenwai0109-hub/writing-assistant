import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHints } from './useHints'
import { SentenceStore } from '../autosave/SentenceStore'
import { api, ApiError } from '../api/writing'
import { hintsFingerprint } from '../api/hintsContext'
import { item, sampleDraft } from '../test/fixtures'
import type { HelpLevel, HintsResponse } from '../types/writing'

const draft = () => sampleDraft({ intentions: [item(1), item(2, 1)], intention_count: 2 })
const output = { intention_summary: 'Explain the purpose.', relationship: 'Introduce the topic.', entities: [], keywords: [], connectives: [], structures: [], examples: [] }
const stores: SentenceStore[] = []
function setup() {
  let saved = draft()
  const save = vi.fn(async (id: number, revision: number, text: string) => {
    const intention = saved.intentions.find(item => item.id === id)!
    Object.assign(intention, { revision: revision + 1, sentence_text: text, status: 'written' }); saved.revision++
    return structuredClone(intention)
  })
  const store = new SentenceStore({ save, get: async () => structuredClone(saved) }, vi.fn()); stores.push(store); store.acceptDraft(structuredClone(saved))
  const hints = vi.spyOn(api, 'hints').mockImplementation(async (id, level, revision, draftRevision) => ({ result: output, context_fingerprint: await hintsFingerprint(store.getSnapshot().draft!, id, level), intention_revision: revision, draft_revision: draftRevision, mode: 'fake' }))
  const hook = renderHook(({ id, level }: { id: number; level: HelpLevel }) => useHints(store, id, level), { initialProps: { id: 1, level: 'hint' as HelpLevel } })
  return { ...hook, store, save, hints }
}
function pendingResponse() { let resolve!: (value: HintsResponse) => void; const promise = new Promise<HintsResponse>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => { localStorage.clear() })
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks() })

describe('hint freshness and request ordering', () => {
  it('flushes every pending sentence before submitting both latest saved revisions', async () => {
    const f = setup(); act(() => { f.store.edit(1, 'Current'); f.store.edit(2, 'Other') })
    await act(() => f.result.current.get())
    expect(f.save).toHaveBeenCalledTimes(2); expect(f.hints).toHaveBeenCalledWith(1, 'hint', 2, 3, expect.any(AbortSignal))
    expect(f.result.current.result?.mode).toBe('fake'); expect(f.store.getSnapshot().pending).toBe(false)
  })
  it('a failed save prevents model requests and preserves text and recovery', async () => {
    const f = setup(); f.save.mockRejectedValueOnce(new ApiError(0, 'Offline'))
    act(() => f.store.edit(1, 'Local')); await act(() => f.result.current.get())
    expect(f.hints).not.toHaveBeenCalled(); expect(f.result.current.error?.message).toMatch(/resolve pending/)
    expect(f.store.getSnapshot().buffers[1].text).toBe('Local'); expect(localStorage.length).toBe(1)
  })
  it('typing aborts pending guidance and ignores a late success', async () => {
    const f = setup(), pending = pendingResponse(); f.hints.mockReturnValueOnce(pending.promise)
    let get!: Promise<void>; act(() => { get = f.result.current.get() }); await waitFor(() => expect(f.hints).toHaveBeenCalledTimes(1))
    act(() => f.store.edit(1, 'New context')); expect(f.hints.mock.calls[0][4]?.aborted).toBe(true)
    await act(async () => { pending.resolve({ result: output, context_fingerprint: await hintsFingerprint(draft(), 1, 'hint'), intention_revision: 1, draft_revision: 1, mode: 'fake' }); await get })
    expect(f.result.current.result).toBeNull(); expect(f.result.current.error).toBeNull()
  })
  it.each(['selection', 'level'] as const)('changing %s clears guidance without automatically making a call', async kind => {
    const f = setup(); await act(() => f.result.current.get()); expect(f.result.current.result).not.toBeNull()
    f.rerender(kind === 'selection' ? { id: 2, level: 'hint' } : { id: 1, level: 'example' })
    expect(f.result.current.result).toBeNull(); expect(f.hints).toHaveBeenCalledTimes(1)
  })
  it('saved-context changes clear displayed guidance', async () => {
    const f = setup(); await act(() => f.result.current.get())
    act(() => f.store.acceptDraft({ ...draft(), revision: 2, topic: 'New topic' }))
    expect(f.result.current.result).toBeNull()
  })
  it('rejects an unexpected fingerprint or revision rather than displaying incompatible guidance', async () => {
    const f = setup(); f.hints.mockResolvedValueOnce({ result: output, context_fingerprint: 'a'.repeat(64), intention_revision: 1, draft_revision: 1, mode: 'fake' })
    await act(() => f.result.current.get()); expect(f.result.current.result).toBeNull(); expect(f.result.current.error?.status).toBe(409)
    f.hints.mockImplementationOnce(async () => ({ result: output, context_fingerprint: await hintsFingerprint(draft(), 1, 'hint'), intention_revision: 2, draft_revision: 1, mode: 'fake' }))
    await act(() => f.result.current.get()); expect(f.result.current.error?.status).toBe(409)
  })
  it('duplicate clicks share one request and failures leave saved sentence data intact', async () => {
    const f = setup(), pending = pendingResponse(); f.hints.mockReturnValueOnce(pending.promise)
    let get!: Promise<void>; act(() => { get = f.result.current.get(); void f.result.current.get() }); await waitFor(() => expect(f.hints).toHaveBeenCalledTimes(1))
    await act(async () => { pending.resolve({ result: output, context_fingerprint: await hintsFingerprint(draft(), 1, 'hint'), intention_revision: 1, draft_revision: 1, mode: 'fake' }); await get })
    f.hints.mockRejectedValueOnce(new ApiError(502, 'Invalid guidance.')); await act(() => f.result.current.get())
    expect(f.result.current.error?.message).toBe('Invalid guidance.'); expect(f.save).not.toHaveBeenCalled()
  })
  it('unmount aborts pending inference and ignores a late response', async () => {
    const f = setup(), pending = pendingResponse(); f.hints.mockReturnValueOnce(pending.promise)
    let get!: Promise<void>; act(() => { get = f.result.current.get() }); await waitFor(() => expect(f.hints).toHaveBeenCalled())
    f.unmount(); expect(f.hints.mock.calls[0][4]?.aborted).toBe(true)
    pending.resolve({ result: output, context_fingerprint: 'a'.repeat(64), intention_revision: 1, draft_revision: 1, mode: 'fake' }); await get
  })
})
