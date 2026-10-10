import { useCallback, useEffect, useRef, useState } from 'react'
import { HealthStatus } from './components/HealthStatus'
import { ConfirmDialog } from './components/ConfirmDialog'
import { DraftsPage } from './pages/DraftsPage'
import { WorkspacePage } from './pages/WorkspacePage'
import type { HelpLevel } from './types/writing'

export type Guard = { dirty: boolean; busy: boolean }
export type PageProps = { navigate: (hash: string) => void; onGuard: (value: Guard) => void }

function route(hash: string): number | null | 'invalid' {
  if (hash === '' || hash === '#/drafts') return null
  const match = /^#\/drafts\/([1-9]\d*)$/.exec(hash)
  if (!match || !Number.isSafeInteger(Number(match[1]))) return 'invalid'
  return Number(match[1])
}

export default function App() {
  const [level, setLevel] = useState<HelpLevel>('hint')
  const [hash, setHash] = useState(() => window.location.hash || '#/drafts')
  const currentHash = useRef(hash)
  const guard = useRef<Guard>({ dirty: false, busy: false })
  const [busy, setBusy] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null)
  const onGuard = useCallback((value: Guard) => { guard.current = value; setBusy(value.busy) }, [])
  const navigate = useCallback((next: string) => {
    if (guard.current.busy || next === currentHash.current) return
    if (guard.current.dirty) { setPendingNavigation(next); return }
    currentHash.current = next
    setHash(next)
    window.location.hash = next
  }, [])
  useEffect(() => {
    function changed() {
      const next = window.location.hash || '#/drafts'
      if (next === currentHash.current) return
      if (guard.current.busy || guard.current.dirty) {
        window.history.replaceState(null, '', currentHash.current)
        if (!guard.current.busy) setPendingNavigation(next)
        return
      }
      currentHash.current = next
      setHash(next)
    }
    function leaving(event: BeforeUnloadEvent) {
      if (guard.current.dirty || guard.current.busy) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('hashchange', changed)
    window.addEventListener('beforeunload', leaving)
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('beforeunload', leaving) }
  }, [])
  const id = route(hash)
  return <div className="shell">
    <header className="app-header"><button className="brand text-link" disabled={busy} onClick={() => navigate('#/drafts')}><span className="brand-mark" aria-hidden="true">w.</span><span>Writing Assistant</span></button><HealthStatus /></header>
    {id === 'invalid' ? <main><h1>Draft address not found</h1><p>Choose a saved draft to continue.</p><button onClick={() => navigate('#/drafts')}>All drafts</button></main> : id === null ? <DraftsPage key="drafts" navigate={navigate} onGuard={onGuard} /> : <WorkspacePage key={id} id={id} navigate={navigate} onGuard={onGuard} level={level} onLevel={setLevel} />}
    <footer>One short paragraph. Your ideas, your sentences.</footer>
    {pendingNavigation && <ConfirmDialog title="Leave unsaved changes?" message="Some edits or recovery choices are unsaved. Settings and intention details will be discarded. Sentence and notes recovery copies remain in this browser when local storage is available." confirmLabel="Discard and leave" onCancel={() => setPendingNavigation(null)} onConfirm={() => { const next = pendingNavigation; setPendingNavigation(null); guard.current = { dirty: false, busy: false }; navigate(next) }} />}
  </div>
}
