import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/writing'

export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError(null)
    load(controller.signal).then(value => { if (active) setData(value) })
      .catch((failure: unknown) => { if (active) setError(failure instanceof ApiError ? failure : new ApiError(0, 'Could not load saved data.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [load, attempt])
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const replaceData = useCallback((value: T) => { setData(value); setError(null) }, [])
  return { data, setData: replaceData, loading, error, retry }
}

export function useOperation() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])
  async function run(action: (signal: AbortSignal) => Promise<void>, onFailure?: (error: ApiError) => void) {
    if (controller.current) return false
    controller.current = new AbortController()
    setBusy(true)
    setError(null)
    try {
      await action(controller.current.signal)
      return mounted.current
    } catch (failure) {
      const error = failure instanceof ApiError ? failure : new ApiError(0, 'Could not complete the request. Refresh saved data before trying again.')
      if (mounted.current) { setError(error); onFailure?.(error) }
      return false
    } finally {
      controller.current = null
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, error, run, clearError: () => setError(null) }
}
