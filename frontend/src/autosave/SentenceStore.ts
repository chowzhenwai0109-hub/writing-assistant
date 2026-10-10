import { ApiError } from '../api/writing'
import type { Draft, Intention } from '../types/writing'
import { browserStorage, discardDraftCopies, readCopies, recoveryIntentionIds, recoveryPrefix, storageMessage } from './recovery'
import type { StoredCopy } from './recovery'

// Python's whitespace-only normalization, including U+0085 and excluding U+FEFF.
export const normalizedSentence = (text: string) => /^[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/u.test(text) ? '' : text
type Problem = 'conflict' | 'error' | 'deleted' | null
type Buffer = { id: number; text: string; notes: string; acknowledged: string; acknowledgedNotes: string; revision: number; server: Intention; problem: Problem; message: string; recoveries: StoredCopy[]; timer?: number; queued: boolean; inFlight: boolean }
export type BufferView = Pick<Buffer, 'id' | 'text' | 'notes' | 'revision' | 'problem' | 'message' | 'recoveries'> & { serverText: string; serverNotes: string; state: 'Saving' | 'Saved' | 'Unsaved' }
export type SentenceSnapshot = { draft: Draft | null; buffers: Record<number, BufferView>; pending: boolean; saving: boolean; epoch: number; warning: string }
export type SentenceAPI = { save: (id: number, revision: number, text: string, signal: AbortSignal, notes: string) => Promise<Intention>; get: (signal: AbortSignal) => Promise<Draft> }

export class SentenceStore {
  private draft: Draft | null = null
  private entries = new Map<number, Buffer>()
  private listeners = new Set<() => void>()
  private owner = crypto.randomUUID()
  private storage: Storage | null
  private warning = ''
  private epoch = 0
  private closed = false
  private reading = false
  private running: Promise<void> | null = null
  private controller: AbortController | null = null
  private snapshot: SentenceSnapshot = { draft: null, buffers: {}, pending: false, saving: false, epoch: 0, warning: '' }
  constructor(private api: SentenceAPI, private onDraft: (draft: Draft) => void, storage: Storage | null = browserStorage()) { this.storage = storage; if (!storage) this.warning = storageMessage }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  mount() { this.closed = false }
  dispose() { this.closed = true; this.controller?.abort(); for (const entry of this.entries.values()) window.clearTimeout(entry.timer) }
  private dirty(entry: Buffer) { return entry.text !== entry.acknowledged || entry.notes !== entry.acknowledgedNotes }
  private publish() {
    const buffers: Record<number, BufferView> = {}
    let pending = false, saving = this.reading
    for (const entry of this.entries.values()) {
      const unresolved = this.dirty(entry) || entry.problem !== null || entry.recoveries.length > 0
      pending ||= unresolved
      saving ||= entry.inFlight || entry.queued
      buffers[entry.id] = { id: entry.id, text: entry.text, notes: entry.notes, revision: entry.revision, problem: entry.problem, message: entry.message, recoveries: entry.recoveries,
        serverText: entry.server.sentence_text ?? '', serverNotes: entry.server.user_notes ?? '', state: entry.problem || entry.recoveries.length ? 'Unsaved' : unresolved || entry.inFlight ? 'Saving' : 'Saved' }
    }
    this.snapshot = { draft: this.draft, buffers, pending, saving, epoch: this.epoch, warning: this.warning }
    if (!this.closed) this.listeners.forEach(listener => listener())
  }
  acceptDraft(draft: Draft) {
    if (this.closed || this.draft === draft || this.draft && draft.revision < this.draft.revision) return
    this.draft = draft
    this.epoch++
    for (const item of draft.intentions) {
      const entry = this.entries.get(item.id)
      if (!entry) {
        const read = readCopies(this.storage, draft, item.id)
        if (read.warning) this.warning = read.warning
        this.entries.set(item.id, { id: item.id, text: item.sentence_text ?? '', notes: item.user_notes ?? '', acknowledged: item.sentence_text ?? '', acknowledgedNotes: item.user_notes ?? '', revision: item.revision, server: item, problem: null, message: '', queued: false, inFlight: false,
          recoveries: read.copies.filter(copy => normalizedSentence(copy.value.text) !== (item.sentence_text ?? '') || copy.value.version === 2 && normalizedSentence(copy.value.notes!) !== (item.user_notes ?? '')) })
      } else {
        entry.server = item
        if (!this.dirty(entry) && !entry.problem && !entry.recoveries.length) { entry.text = item.sentence_text ?? ''; entry.acknowledged = entry.text; entry.notes = item.user_notes ?? ''; entry.acknowledgedNotes = entry.notes; entry.revision = item.revision }
        else if (item.revision !== entry.revision && !entry.recoveries.length) { entry.problem = 'conflict'; entry.message = 'Saved writing changed. Review both versions before saving your edits.'; entry.queued = false }
      }
    }
    for (const entry of this.entries.values()) if (!draft.intentions.some(item => item.id === entry.id)) {
      if (this.dirty(entry) || entry.inFlight || entry.problem || entry.recoveries.length) { entry.problem = 'deleted'; entry.message = 'This intention was removed. Your local sentence and notes are retained for recovery.'; entry.queued = false }
      else this.entries.delete(entry.id)
    }
    for (const id of recoveryIntentionIds(this.storage, draft)) if (!this.entries.has(id) && !draft.intentions.some(item => item.id === id)) {
      const read = readCopies(this.storage, draft, id)
      if (read.warning) this.warning = read.warning
      if (read.copies.length) this.entries.set(id, { id, text: '', notes: '', acknowledged: '', acknowledgedNotes: '', revision: read.copies[0].value.base_revision, server: { id, sentence_text: null } as Intention,
        problem: 'deleted', message: 'This intention was removed. Local recovery copies are still available.', recoveries: read.copies, queued: false, inFlight: false })
    }
    this.publish()
    this.onDraft(draft)
  }
  private key(entry: Buffer) { return recoveryPrefix(this.draft!, entry.id) + this.owner }
  private persist(entry: Buffer): boolean {
    try {
      if (!this.storage) throw new Error('Storage unavailable')
      this.storage.setItem(this.key(entry), JSON.stringify({ version: 2, draft_id: this.draft!.id, draft_created_at: this.draft!.created_at, intention_id: entry.id, owner: this.owner, text: entry.text, notes: entry.notes, base_revision: entry.revision, updated_at: Date.now() }))
      return true
    } catch { this.warning = storageMessage; return false }
  }
  private clearOwned(entry: Buffer, text?: string, notes?: string) {
    try {
      const raw = this.storage?.getItem(this.key(entry))
      if (raw && (text === undefined || (JSON.parse(raw).text === text && JSON.parse(raw).notes === notes))) this.storage!.removeItem(this.key(entry))
    } catch { this.warning = storageMessage }
  }
  edit(id: number, text: string) { this.editField(id, 'text', text) }
  editNotes(id: number, notes: string) { this.editField(id, 'notes', notes) }
  private editField(id: number, field: 'text' | 'notes', value: string) {
    const entry = this.entries.get(id)
    if (!entry || this.closed || entry.recoveries.length || entry.problem === 'deleted') return
    entry[field] = value; this.epoch++
    window.clearTimeout(entry.timer)
    if (this.dirty(entry) || entry.inFlight) {
      this.persist(entry)
      if (!entry.problem) entry.timer = window.setTimeout(() => { entry.queued = true; this.publish(); void this.pump() }, 600)
    } else this.clearOwned(entry)
    this.publish()
  }
  private pump(): Promise<void> {
    if (this.reading || this.closed) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.drain().finally(() => { this.running = null; this.publish() })
    return this.running
  }
  private async drain() {
    while (!this.closed) {
      const entry = [...this.entries.values()].find(entry => entry.queued && !entry.problem && !entry.recoveries.length)
      if (!entry) break
      entry.queued = false
      if (!this.dirty(entry)) continue
      const text = entry.text, notes = entry.notes
      entry.inFlight = true; this.publish()
      this.controller = new AbortController()
      try {
        const saved = await this.api.save(entry.id, entry.revision, text, this.controller.signal, notes)
        if (this.closed) return
        entry.revision = saved.revision; entry.acknowledged = text; entry.acknowledgedNotes = notes; entry.server = saved
        // Keep the newer buffer and its updated base revision before re-reading.
        if (this.dirty(entry)) this.persist(entry)
        const draft = await this.api.get(this.controller.signal)
        if (this.closed) return
        this.acceptDraft(draft)
        if (!entry.problem && !this.dirty(entry)) this.clearOwned(entry, text, notes)
      } catch (error) {
        if (this.closed) return
        entry.problem = error instanceof ApiError && error.status === 409 ? 'conflict' : 'error'
        entry.message = error instanceof Error ? error.message : 'Could not save the sentence and notes. Your text is retained.'
        entry.queued = false
        if (entry.problem === 'conflict') {
          try { this.acceptDraft(await this.api.get(this.controller.signal)) } catch { entry.problem = 'error'; entry.message = 'Could not refresh saved writing. Retry the save to refresh before another write.' }
        }
      } finally { entry.inFlight = false; this.controller = null; this.publish() }
    }
  }
  async flush(id?: number): Promise<boolean> {
    if (this.reading || this.closed) return false
    for (;;) {
      for (const entry of this.entries.values()) if ((id === undefined || entry.id === id) && this.dirty(entry) && !entry.problem && !entry.recoveries.length) { window.clearTimeout(entry.timer); entry.queued = true }
      this.publish()
      await this.pump()
      if (this.closed) return false
      const entries = [...this.entries.values()].filter(entry => id === undefined || entry.id === id)
      if (entries.some(entry => entry.problem || entry.recoveries.length)) return false
      if (!entries.some(entry => this.dirty(entry))) return true
    }
  }
  async retry(id: number) {
    const entry = this.entries.get(id)
    if (!entry || this.running || this.reading || this.closed) return
    this.reading = true; this.publish()
    this.controller = new AbortController()
    try {
      const draft = await this.api.get(this.controller.signal)
      if (this.closed) return
      this.acceptDraft(draft)
      const latest = draft.intentions.find(item => item.id === id)
      if (!latest) { entry.problem = 'deleted'; entry.message = 'This intention was removed. Your local sentence and notes are retained.' }
      else if (normalizedSentence(entry.text) === (latest.sentence_text ?? '') && normalizedSentence(entry.notes) === (latest.user_notes ?? '')) {
        entry.acknowledged = entry.text; entry.acknowledgedNotes = entry.notes; entry.revision = latest.revision; entry.problem = null; entry.message = ''; this.clearOwned(entry, entry.text, entry.notes)
      } else if (latest.revision !== entry.revision) { entry.problem = 'conflict'; entry.message = 'Saved writing changed. Review both versions before saving your edits.' }
      else { entry.problem = null; entry.message = ''; entry.queued = true }
    } catch { entry.problem = 'error'; entry.message = 'Could not refresh saved writing. Your text is retained; retry when connected.' }
    finally { this.controller = null; this.reading = false; this.publish() }
    await this.pump()
  }
  async keep(id: number) {
    const entry = this.entries.get(id)
    if (!entry || entry.problem === 'deleted' || this.running || this.reading) return
    entry.revision = entry.server.revision; entry.acknowledged = entry.server.sentence_text ?? ''; entry.acknowledgedNotes = entry.server.user_notes ?? ''; entry.problem = null; entry.message = ''
    if (this.dirty(entry)) this.persist(entry); else this.clearOwned(entry)
    this.publish(); await this.flush(id)
  }
  useSaved(id: number) {
    const entry = this.entries.get(id)
    if (!entry || entry.inFlight || this.reading) return
    this.clearOwned(entry)
    if (entry.problem === 'deleted') this.entries.delete(id)
    else { entry.text = entry.server.sentence_text ?? ''; entry.acknowledged = entry.text; entry.notes = entry.server.user_notes ?? ''; entry.acknowledgedNotes = entry.notes; entry.revision = entry.server.revision; entry.problem = null; entry.message = ''; entry.queued = false }
    this.epoch++; this.publish()
  }
  async restore(id: number, copy: StoredCopy) {
    const entry = this.entries.get(id)
    if (!entry || this.running || this.reading || this.closed) return
    this.reading = true; this.publish()
    this.controller = new AbortController()
    try {
      const draft = await this.api.get(this.controller.signal)
      if (this.closed) return
      this.acceptDraft(draft)
      const latest = draft.intentions.find(item => item.id === id)
      entry.text = copy.value.text; entry.notes = copy.value.version === 2 ? copy.value.notes! : latest ? latest.user_notes ?? '' : entry.notes; entry.recoveries = []; entry.revision = copy.value.base_revision; this.epoch++
      if (!latest) { entry.problem = 'deleted'; entry.message = 'This intention was removed. Your recovered text is retained.' }
      else if (latest.revision !== copy.value.base_revision) { entry.problem = 'conflict'; entry.message = 'The saved version changed since this recovery copy. Review both versions.' }
      else { entry.problem = null; entry.message = ''; entry.acknowledged = latest.sentence_text ?? ''; entry.acknowledgedNotes = latest.user_notes ?? '' }
      if (this.persist(entry)) this.discardExact(copy)
      if (!entry.problem && !this.dirty(entry)) this.clearOwned(entry)
      this.publish()
      if (!entry.problem && this.dirty(entry)) entry.queued = true
    } catch { entry.message = 'Could not refresh saved writing before recovery. Please retry restoring the copy.'; this.publish() }
    finally { this.controller = null; this.reading = false; this.publish() }
    await this.pump()
  }
  private discardExact(copy: StoredCopy) {
    try { if (this.storage?.getItem(copy.key) === copy.raw) this.storage.removeItem(copy.key) } catch { this.warning = storageMessage }
  }
  discardRecovery(id: number, copy: StoredCopy) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.discardExact(copy); entry.recoveries = entry.recoveries.filter(item => item.key !== copy.key); this.publish()
  }
  discardDeleted(ids: number[]) {
    if (!this.draft) return
    const warning = discardDraftCopies(this.draft, ids, this.storage)
    if (warning) this.warning = warning
    for (const id of ids) { window.clearTimeout(this.entries.get(id)?.timer); this.entries.delete(id) }
    this.publish()
  }
}
