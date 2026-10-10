import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SentenceStore, normalizedSentence } from './SentenceStore'
import { readCopies, recoveryPrefix } from './recovery'
import { ApiError } from '../api/writing'
import { item, sampleDraft } from '../test/fixtures'
import type { Draft, Intention } from '../types/writing'

const stores: SentenceStore[] = []
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(storage: Storage | null = localStorage) {
  let draft = sampleDraft({ intentions: [item(1), item(2, 1)], intention_count: 2 })
  const save = vi.fn(async (id: number, revision: number, text: string, _signal: AbortSignal, notes = ''): Promise<Intention> => {
    const current = draft.intentions.find(item => item.id === id)!
    if (current.revision !== revision) throw new ApiError(409, 'Saved writing changed.')
    Object.assign(current, { sentence_text: normalizedSentence(text) || null, user_notes: normalizedSentence(notes) || null, revision: revision + 1, status: normalizedSentence(text) ? 'written' : 'pending' })
    draft.revision++; return structuredClone(current)
  })
  const get = vi.fn(async (_signal: AbortSignal) => structuredClone(draft))
  const store = new SentenceStore({ save, get }, vi.fn(), storage); stores.push(store); store.acceptDraft(structuredClone(draft))
  return { store, save, get, draft: () => draft, change: (update: Partial<Draft>) => { draft = { ...draft, ...update } } }
}
function copy(draft: Draft, id: number, text: string, owner = 'old-tab', base = 1) {
  const key = recoveryPrefix(draft, id) + owner
  localStorage.setItem(key, JSON.stringify({ version: 1, draft_id: draft.id, draft_created_at: draft.created_at, intention_id: id, owner, text, base_revision: base, updated_at: Date.now() }))
  return readCopies(localStorage, draft, id).copies.find(value => value.key === key)!
}
beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.useRealTimers() })

describe('sentence autosave and recovery', () => {
  it('coalesces sentence and notes into one revision-guarded save and notes alone remain pending status', async () => {
    const f = fixture(); f.store.editNotes(1, '中文 notes'); await f.store.flush()
    expect(f.draft().intentions[0]).toMatchObject({ sentence_text: null, user_notes: '中文 notes', status: 'pending', revision: 2 })
    f.store.edit(1, 'Sentence'); f.store.editNotes(1, 'More notes'); await f.store.flush()
    expect(f.save.mock.calls.map(call => [call[0], call[1], call[2], call[4]])).toEqual([[1, 1, '', '中文 notes'], [1, 2, 'Sentence', 'More notes']])
    expect(f.store.getSnapshot().buffers[1]).toMatchObject({ text: 'Sentence', notes: 'More notes', state: 'Saved' })
  })
  it('newer notes survive an older sentence-and-notes reply and use its new revision', async () => {
    const f = fixture(), pending = deferred<Intention>(), actual = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(() => pending.promise); f.store.edit(1, 'Sentence'); f.store.editNotes(1, 'First notes'); const flush = f.store.flush()
    f.store.editNotes(1, 'New notes'); await vi.advanceTimersByTimeAsync(600)
    pending.resolve(await actual(1, 1, 'Sentence', new AbortController().signal, 'First notes')); await flush
    expect(f.save.mock.calls.map(call => [call[1], call[2], call[4]])).toEqual([[1, 'Sentence', 'First notes'], [2, 'Sentence', 'New notes']])
    expect(f.draft().intentions[0].user_notes).toBe('New notes'); expect(localStorage.length).toBe(0)
  })
  it('notes-only recovery is offered even when sentence text matches saved data', async () => {
    const f = fixture(); f.store.editNotes(1, 'Recover notes'); f.store.dispose()
    const next = fixture(); const savedCopy = next.store.getSnapshot().buffers[1].recoveries[0]
    expect(savedCopy.value).toMatchObject({ version: 2, text: '', notes: 'Recover notes' }); expect(next.save).not.toHaveBeenCalled()
    await next.store.restore(1, savedCopy); expect(next.draft().intentions[0].user_notes).toBe('Recover notes'); expect(localStorage.length).toBe(0)
  })
  it('legacy sentence-only copies preserve saved notes when restored', async () => {
    const f = fixture(); f.change({ intentions: [{ ...item(1), user_notes: 'Saved notes' }, item(2, 1)] })
    const old = copy(f.draft(), 1, 'Legacy sentence')
    const next = new SentenceStore({ save: f.save, get: f.get }, vi.fn()); stores.push(next); next.acceptDraft(structuredClone(f.draft()))
    await next.restore(1, old); expect(f.draft().intentions[0]).toMatchObject({ sentence_text: 'Legacy sentence', user_notes: 'Saved notes' })
  })
  it('legacy recovery preserves notes cleared externally rather than bringing old notes back', async () => {
    const f = fixture(); f.change({ intentions: [{ ...item(1), user_notes: 'Old notes' }, item(2, 1)] }); const old = copy(f.draft(), 1, 'Old sentence')
    const next = new SentenceStore({ save: f.save, get: f.get }, vi.fn()); stores.push(next); next.acceptDraft(structuredClone(f.draft()))
    f.change({ revision: 2, intentions: [{ ...item(1), user_notes: null, revision: 2 }, item(2, 1)] }); await next.restore(1, old)
    expect(next.getSnapshot().buffers[1]).toMatchObject({ text: 'Old sentence', notes: '', problem: 'conflict' }); await next.keep(1)
    expect(f.draft().intentions[0].user_notes).toBeNull()
  })
  it('read-first retry reconciles both fields after a response lost following a committed notes save', async () => {
    const f = fixture(), actual = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(async (...args) => { await actual(...args); throw new ApiError(0, 'Lost') })
    f.store.editNotes(1, 'Already saved'); await f.store.flush(); expect(localStorage.length).toBe(1)
    await f.store.retry(1); expect(f.save).toHaveBeenCalledTimes(1); expect(f.store.getSnapshot().buffers[1].state).toBe('Saved'); expect(localStorage.length).toBe(0)
  })
  it('same server sentence with conflicting notes requires explicit review of both versions', async () => {
    const f = fixture(); f.store.editNotes(1, 'Local notes'); f.change({ revision: 2, intentions: [{ ...item(1), user_notes: 'Other notes', revision: 2 }, item(2, 1)] })
    await f.store.flush(); expect(f.store.getSnapshot().buffers[1]).toMatchObject({ notes: 'Local notes', serverNotes: 'Other notes', problem: 'conflict' })
    f.store.useSaved(1); expect(f.store.getSnapshot().buffers[1].notes).toBe('Other notes'); expect(localStorage.length).toBe(0)
  })
  it('an exact sentence acknowledgement cannot erase a copy containing newer notes', async () => {
    const f = fixture(), pending = deferred<Intention>(), actual = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(() => pending.promise); f.store.edit(1, 'Same sentence'); const flush = f.store.flush(1)
    f.store.editNotes(1, 'New notes'); f.save.mockRejectedValueOnce(new ApiError(0, 'Offline'))
    pending.resolve(await actual(1, 1, 'Same sentence', new AbortController().signal)); await flush
    expect(readCopies(localStorage, f.draft(), 1).copies[0].value.notes).toBe('New notes'); expect(f.store.getSnapshot().buffers[1].notes).toBe('New notes')
  })
  it('invalid paired recovery data is rejected without changing saved notes', () => {
    const f = fixture(), old = copy(f.draft(), 1, 'Text')
    localStorage.setItem(old.key, JSON.stringify({ ...old.value, version: 2, notes: null }))
    const next = fixture(); expect(next.store.getSnapshot().buffers[1].recoveries).toHaveLength(0); expect(next.store.getSnapshot().warning).toMatch(/could not be read/)
  })
  it('debounces and coalesces typing, preserves exact text, then updates status and parent revision', async () => {
    const f = fixture(); f.store.edit(1, 'A'); await vi.advanceTimersByTimeAsync(500); f.store.edit(1, ' A sentence. ')
    expect(localStorage.length).toBe(1); expect(f.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(f.save).toHaveBeenCalledExactlyOnceWith(1, 1, ' A sentence. ', expect.any(AbortSignal), '')
    expect(f.store.getSnapshot().buffers[1].state).toBe('Saved'); expect(f.store.getSnapshot().draft?.revision).toBe(2)
    expect(f.store.getSnapshot().draft?.intentions[0].status).toBe('written'); expect(localStorage.length).toBe(0)
  })
  it('serializes all intentions, coalesces newer edits and cannot acknowledge them with an older reply', async () => {
    const f = fixture(), first = deferred<Intention>(), actual = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(() => first.promise)
    f.store.edit(1, 'First'); const flush = f.store.flush()
    f.store.edit(1, 'Newest'); f.store.edit(2, 'Second'); await vi.advanceTimersByTimeAsync(600)
    expect(f.save).toHaveBeenCalledTimes(1); expect(localStorage.length).toBe(2)
    first.resolve(await actual(1, 1, 'First', new AbortController().signal)); await flush
    expect(f.save.mock.calls.map(call => call.slice(0, 3))).toEqual([[1, 1, 'First'], [1, 2, 'Newest'], [2, 1, 'Second']])
    expect(f.draft().intentions.map(item => item.sentence_text)).toEqual(['Newest', 'Second']); expect(localStorage.length).toBe(0)
  })
  it('retains a reversion typed while a previous save is in flight, and saves that reversion', async () => {
    const f = fixture(), pending = deferred<Intention>(), actual = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(() => pending.promise); f.store.edit(1, 'Temporary'); const flush = f.store.flush()
    f.store.edit(1, ''); expect(localStorage.length).toBe(1)
    pending.resolve(await actual(1, 1, 'Temporary', new AbortController().signal)); await flush
    expect(f.save.mock.calls.map(call => call.slice(0, 3))).toEqual([[1, 1, 'Temporary'], [1, 2, '']])
    expect(f.draft().intentions[0].sentence_text).toBeNull(); expect(localStorage.length).toBe(0)
  })
  it('flushes the departing intention without mixing another intention buffer', async () => {
    const f = fixture(); f.store.edit(1, 'One'); f.store.edit(2, 'Two'); await f.store.flush(1)
    expect(f.draft().intentions[0].sentence_text).toBe('One'); expect(f.draft().intentions[1].sentence_text).toBeNull()
    expect(f.store.getSnapshot().buffers[2].text).toBe('Two'); await f.store.flush(); expect(f.draft().intentions[1].sentence_text).toBe('Two')
  })
  it('pauses conflicts, preserves both versions and requires an explicit revision choice', async () => {
    const f = fixture(); f.store.edit(1, 'Local'); f.change({ revision: 2, intentions: [{ ...item(1), sentence_text: 'Other tab', revision: 2 }, item(2, 1)] })
    expect(await f.store.flush()).toBe(false); expect(f.store.getSnapshot().buffers[1]).toMatchObject({ text: 'Local', serverText: 'Other tab', problem: 'conflict' })
    await vi.advanceTimersByTimeAsync(2000); expect(f.save).toHaveBeenCalledTimes(1)
    await f.store.keep(1); expect(f.save.mock.calls[1].slice(0, 3)).toEqual([1, 2, 'Local']); expect(f.store.getSnapshot().pending).toBe(false)
  })
  it('use saved explicitly discards only the owned local buffer', async () => {
    const f = fixture(); f.store.edit(1, 'Local'); const other = copy(f.draft(), 1, 'Another copy')
    f.change({ revision: 2, intentions: [{ ...item(1), sentence_text: 'Server', revision: 2 }, item(2, 1)] }); await f.store.flush()
    f.store.useSaved(1); expect(f.store.getSnapshot().buffers[1].text).toBe('Server'); expect(localStorage.getItem(other.key)).toBe(other.raw)
  })
  it('a lost response reads first on retry and does not replay a write that already committed', async () => {
    const f = fixture(), actual = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(async (...args) => { await actual(...args); throw new ApiError(0, 'Response lost.') })
    f.store.edit(1, 'Committed'); expect(await f.store.flush()).toBe(false)
    expect(f.store.getSnapshot().buffers[1].state).toBe('Unsaved'); expect(localStorage.length).toBe(1)
    await f.store.retry(1); expect(f.save).toHaveBeenCalledTimes(1); expect(f.get).toHaveBeenCalledTimes(1)
    expect(f.store.getSnapshot().buffers[1].state).toBe('Saved'); expect(localStorage.length).toBe(0)
  })
  it('an unsuccessful retry read preserves unsaved text and never writes', async () => {
    const f = fixture(); f.save.mockRejectedValueOnce(new ApiError(0, 'Offline')); f.store.edit(1, 'Local'); await f.store.flush()
    f.get.mockRejectedValueOnce(new ApiError(0, 'Offline')); await f.store.retry(1)
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.store.getSnapshot().buffers[1]).toMatchObject({ text: 'Local', problem: 'error' }); expect(localStorage.length).toBe(1)
  })
  it('failed refresh after successful PATCH retains recovery until explicit retry confirms it', async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new ApiError(0, 'Offline')); f.store.edit(1, 'Saved'); await f.store.flush()
    expect(f.store.getSnapshot().buffers[1].state).toBe('Unsaved'); expect(localStorage.length).toBe(1)
    await f.store.retry(1); expect(f.save).toHaveBeenCalledTimes(1); expect(localStorage.length).toBe(0)
  })
  it('offers reload recovery without writing, then restores a chosen copy', async () => {
    const f = fixture(); f.store.edit(1, 'Recover me'); f.store.dispose()
    const next = fixture(); expect(next.store.getSnapshot().buffers[1].recoveries).toHaveLength(1); expect(next.save).not.toHaveBeenCalled()
    const savedCopy = next.store.getSnapshot().buffers[1].recoveries[0]; await next.store.restore(1, savedCopy)
    expect(next.draft().intentions[0].sentence_text).toBe('Recover me'); expect(localStorage.length).toBe(0)
  })
  it('restoring a stale copy pauses for review instead of overwriting newer writing', async () => {
    const f = fixture(), savedCopy = copy(f.draft(), 1, 'Old local')
    const next = fixture(); next.change({ revision: 2, intentions: [{ ...item(1), sentence_text: 'New server', revision: 2 }, item(2, 1)] })
    await next.store.restore(1, savedCopy)
    expect(next.save).not.toHaveBeenCalled(); expect(next.store.getSnapshot().buffers[1]).toMatchObject({ text: 'Old local', serverText: 'New server', problem: 'conflict' })
    await next.store.keep(1); expect(next.save.mock.calls[0].slice(0, 3)).toEqual([1, 2, 'Old local'])
  })
  it('separate tab owners retain multiple copies and discarding an old snapshot cannot delete a newer copy', () => {
    const a = fixture(), b = fixture(); a.store.edit(1, 'A'); b.store.edit(1, 'B'); expect(localStorage.length).toBe(2)
    const reload = fixture(), copies = reload.store.getSnapshot().buffers[1].recoveries; expect(copies.map(copy => copy.value.text).sort()).toEqual(['A', 'B'])
    localStorage.setItem(copies[0].key, copies[0].raw + ' '); reload.store.discardRecovery(1, copies[0]); expect(localStorage.getItem(copies[0].key)).toBe(copies[0].raw + ' ')
  })
  it('scope includes draft creation time so IDs reused after a database reset do not offer unrelated writing', () => {
    const f = fixture(); copy({ ...f.draft(), created_at: '2020-01-01T00:00:00Z' }, 1, 'Unrelated')
    const next = fixture(); expect(next.store.getSnapshot().buffers[1].recoveries).toEqual([])
  })
  it('external deletion preserves local text and orphan recovery survives reload', async () => {
    const f = fixture(); f.store.edit(1, 'Orphan'); f.change({ revision: 2, intentions: [item(2, 0)], intention_count: 1 }); f.store.acceptDraft(structuredClone(f.draft()))
    expect(f.store.getSnapshot().buffers[1]).toMatchObject({ text: 'Orphan', problem: 'deleted' }); expect(await f.store.flush()).toBe(false)
    const reload = new SentenceStore({ save: f.save, get: f.get }, vi.fn()); stores.push(reload); reload.acceptDraft(structuredClone(f.draft()))
    const recovery = reload.getSnapshot().buffers[1].recoveries[0]; expect(recovery.value.text).toBe('Orphan')
    await reload.restore(1, recovery); expect(reload.getSnapshot().buffers[1]).toMatchObject({ text: 'Orphan', problem: 'deleted' }); expect(f.save).not.toHaveBeenCalled()
  })
  it('intentional deletion clears only related recovery copies', () => {
    const f = fixture(); f.store.edit(1, 'One'); f.store.edit(2, 'Two'); f.store.discardDeleted([1])
    expect(readCopies(localStorage, f.draft(), 1).copies).toEqual([]); expect(readCopies(localStorage, f.draft(), 2).copies).toHaveLength(1)
  })
  it('warns on unavailable or corrupt storage while preserving usable saved data', () => {
    const f = fixture(null); f.store.edit(1, 'Text'); expect(f.store.getSnapshot().warning).toMatch(/recovery is unavailable/)
    localStorage.setItem(recoveryPrefix(f.draft(), 1) + 'bad', '{broken')
    const next = fixture(); expect(next.store.getSnapshot().warning).toMatch(/could not be read/); expect(next.store.getSnapshot().buffers[1].text).toBe('')
  })
  it('quota failure preserves text in memory and reports unavailable recovery', () => {
    const badStorage = { ...localStorage, length: 0, setItem: () => { throw new Error('Quota') }, getItem: () => null, key: () => null } as unknown as Storage
    const f = fixture(badStorage); f.store.edit(1, 'Still here'); expect(f.store.getSnapshot().buffers[1].text).toBe('Still here'); expect(f.store.getSnapshot().warning).toMatch(/unavailable/)
  })
  it('unmount cancels the request and retains the recovery copy without applying a late result', async () => {
    const f = fixture(), pending = deferred<Intention>(); f.save.mockImplementationOnce(() => pending.promise)
    f.store.edit(1, 'Retained'); const flush = f.store.flush(); const signal = f.save.mock.calls[0][3]; f.store.dispose()
    expect(signal.aborted).toBe(true); pending.resolve({ ...item(1), sentence_text: 'Retained', revision: 2 }); expect(await flush).toBe(false)
    expect(f.get).not.toHaveBeenCalled(); expect(localStorage.length).toBe(1)
  })
  it('blank normalization matches Python while nonblank content is untouched', () => {
    expect(normalizedSentence(' \n\u0085')).toBe(''); expect(normalizedSentence('\uFEFF')).toBe('\uFEFF'); expect(normalizedSentence(' text ')).toBe(' text ')
  })
})
