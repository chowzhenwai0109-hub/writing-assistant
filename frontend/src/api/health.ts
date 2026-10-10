export async function getHealth(signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/health', { signal })
  if (!response.ok) throw new Error('The backend is unavailable. Check the dev server and retry.')
  const data: unknown = await response.json()
  if (
    typeof data !== 'object' || data === null ||
    !('status' in data) || data.status !== 'ok'
  ) {
    throw new Error('The backend returned an unexpected health response.')
  }
}
