import type { ApiError } from '../api/writing'

export function Failure({ error, onRetry, retryLabel = 'Retry', busy = false }: { error: ApiError | null; onRetry?: () => void; retryLabel?: string; busy?: boolean }) {
  if (!error) return null
  return <div role="alert" className="error-box"><p>{error.message}</p>{onRetry && <button className="secondary" disabled={busy} onClick={onRetry}>{retryLabel}</button>}</div>
}
