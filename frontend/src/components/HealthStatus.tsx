import { useEffect, useState } from 'react'
import { getHealth } from '../api/health'

export function HealthStatus() {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => controller.abort(), 5000)
    setState('loading')
    getHealth(controller.signal).then(() => { if (active) setState('ok') }).catch((error: unknown) => {
      if (active) { setState('error'); setMessage(controller.signal.aborted ? 'The connection timed out. Check the dev server and retry.' : error instanceof Error ? error.message : 'Could not connect to the backend.') }
    }).finally(() => window.clearTimeout(timeout))
    return () => { active = false; controller.abort(); window.clearTimeout(timeout) }
  }, [attempt])
  return <div className="health"><span role="status">{state === 'ok' ? 'backend: ok' : state === 'loading' ? 'Connecting to backend…' : 'Backend connection needs attention'}</span>
    {state === 'error' && <><span>{message}</span><button className="secondary small" onClick={() => setAttempt(value => value + 1)}>Retry connection</button></>}
  </div>
}
