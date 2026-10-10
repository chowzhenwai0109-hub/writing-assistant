import type { Draft } from '../types/writing'

export type RecoveryCopy = {
  version: 1 | 2; draft_id: number; draft_created_at: string; intention_id: number
  owner: string; text: string; notes?: string; base_revision: number; updated_at: number
}
export type StoredCopy = { key: string; raw: string; value: RecoveryCopy }
export const recoveryPrefix = (draft: Pick<Draft, 'id' | 'created_at'>, intentionId?: number) => `writing-assistant:sentence:v1:${draft.id}:${encodeURIComponent(draft.created_at)}:${intentionId === undefined ? '' : `${intentionId}:`}`
export const storageMessage = 'Local sentence and notes recovery is unavailable. Keep this page open until your edits are saved.'

export function browserStorage(): Storage | null { try { return window.localStorage } catch { return null } }

export function recoveryIntentionIds(storage: Storage | null, draft: Draft): number[] {
  if (!storage) return []
  const ids = new Set<number>()
  const prefix = recoveryPrefix(draft)
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const id = Number(key.slice(prefix.length).split(':')[0])
      if (Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
  } catch { /* readCopies reports storage failures for the known intentions. */ }
  return [...ids]
}

export function readCopies(storage: Storage | null, draft: Draft, intentionId: number): { copies: StoredCopy[]; warning: string } {
  if (!storage) return { copies: [], warning: storageMessage }
  const copies: StoredCopy[] = []
  let warning = ''
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(recoveryPrefix(draft, intentionId))) continue
      try {
        const raw = storage.getItem(key)!
        const value: RecoveryCopy = JSON.parse(raw)
        if (![1, 2].includes(value.version) || value.draft_id !== draft.id || value.draft_created_at !== draft.created_at || value.intention_id !== intentionId ||
          typeof value.owner !== 'string' || key !== recoveryPrefix(draft, intentionId) + value.owner ||
          typeof value.text !== 'string' || Array.from(value.text).length > 4000 || !Number.isSafeInteger(value.base_revision) || value.base_revision < 1 ||
          value.version === 2 && (typeof value.notes !== 'string' || Array.from(value.notes).length > 4000) ||
          !Number.isSafeInteger(value.updated_at) || value.updated_at <= 0 || value.updated_at > 8_640_000_000_000_000) throw new Error('Invalid recovery')
        copies.push({ key, raw, value })
      } catch { warning = 'Some sentence recovery data could not be read. Your saved writing is unchanged.' }
    }
  } catch { warning = storageMessage }
  return { copies: copies.sort((a, b) => b.value.updated_at - a.value.updated_at), warning }
}

export function discardDraftCopies(draft: Pick<Draft, 'id' | 'created_at'>, intentionIds?: number[], storage = browserStorage()): string {
  if (!storage) return storageMessage
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null)
    for (const key of keys) if (intentionIds ? intentionIds.some(id => key.startsWith(recoveryPrefix(draft, id))) : key.startsWith(recoveryPrefix(draft))) storage.removeItem(key)
    return ''
  } catch { return storageMessage }
}
