import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Draft } from './types/writing'
import { item, jsonResponse, sampleDraft } from './test/fixtures'

beforeEach(() => { window.history.replaceState(null, '', '#/drafts') })

function backend(initial = sampleDraft()) {
  let draft = structuredClone(initial)
  let exists = true
  let fail: { path: string; status: number; detail: string } | null = null
  const fetchMock = vi.fn(async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? 'GET'
    const body = options.body ? JSON.parse(String(options.body)) : null
    if (path === '/api/health') return jsonResponse({ status: 'ok' })
    if (fail && path.includes(fail.path) && method !== 'GET') return jsonResponse({ detail: fail.detail }, fail.status)
    if (path === '/api/drafts' && method === 'GET') return jsonResponse(exists ? [draft] : [])
    if (path === '/api/drafts' && method === 'POST') { draft = sampleDraft(body); exists = true; return jsonResponse(draft, 201) }
    if (method === 'DELETE' && path.startsWith('/api/drafts/1?')) { exists = false; return jsonResponse(null, 204) }
    if (path === '/api/drafts/1' && method === 'GET') return jsonResponse(draft)
    if (body?.expected_revision !== undefined && body.expected_revision !== (path.startsWith('/api/intentions/') ? draft.intentions.find(item => item.id === Number(path.split('/')[3]))?.revision : draft.revision)) return jsonResponse({ detail: 'Saved data changed. Refresh and review it.' }, 409)
    if (path.endsWith('/generate')) { draft = { ...draft, revision: draft.revision + 1, intentions: [item(10), item(11, 1), item(12, 2)], intention_count: 3, last_generation_mode: 'fake' }; return jsonResponse({ ...draft, mode: 'fake' }) }
    if (path.endsWith('/order')) { draft.intentions = body.ordered_ids.map((id: number, position: number) => ({ ...draft.intentions.find(item => item.id === id), position })); draft.revision++; return jsonResponse(draft) }
    if (path === '/api/drafts/1' && method === 'PATCH') { const { expected_revision: _, ...fields } = body; draft = { ...draft, ...fields, revision: draft.revision + 1 }; return jsonResponse(draft) }
    if (path === '/api/drafts/1/intentions' && method === 'POST') { if (body.expected_draft_revision !== draft.revision) return jsonResponse({ detail: 'Saved data changed.' }, 409); const { expected_draft_revision: _, ...fields } = body; const added = { ...item(20, draft.intentions.length), ...fields }; draft.intentions.push(added); draft.intention_count++; draft.revision++; return jsonResponse(added, 201) }
    if (path.startsWith('/api/intentions/') && method === 'PATCH') { const id = Number(path.split('/')[3]); const current = draft.intentions.find(item => item.id === id)!; const { expected_revision: _, ...fields } = body; Object.assign(current, fields, { revision: current.revision + 1 }); draft.revision++; return jsonResponse(current) }
    if (path.startsWith('/api/intentions/') && method === 'DELETE') { const id = Number(path.split('/')[3].split('?')[0]); draft.intentions = draft.intentions.filter(item => item.id !== id).map((item, position) => ({ ...item, position })); draft.intention_count--; draft.revision++; return jsonResponse(null, 204) }
    throw new Error(`Unexpected mock request: ${method} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, get: () => draft, change: (changes: Partial<Draft>) => { draft = { ...draft, ...changes } }, fail: (value: typeof fail) => { fail = value } }
}
const click = (name: string | RegExp) => {
  const dialog = screen.queryByRole('dialog')
  fireEvent.click((dialog ? within(dialog) : screen).getByRole('button', { name }))
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
async function open() { click('My paragraph'); await screen.findByRole('button', { name: 'Generate sequence' }) }
async function save(kind: 'Draft settings' | 'Intention details' = 'Intention details') { fireEvent.submit(screen.getByRole('form', { name: kind })); await waitFor(() => expect(screen.queryByRole('form', { name: kind })).not.toBeInTheDocument()) }

describe('macro workspace', () => {
  it('creates with settings, generates, edits, reorders and reopens persisted data', async () => {
    const server = backend(); server.fetchMock.mockImplementationOnce(async () => jsonResponse({ status: 'ok' }))
    render(<App />); await screen.findByText('My paragraph')
    click('New draft'); fill('Title', 'New paragraph'); fill('Topic', 'A clear topic'); fill('Minimum words (optional)', '60'); fill('Maximum words (optional)', '90')
    fill('Planned sentences', '3'); await save('Draft settings')
    await screen.findByRole('heading', { name: 'New paragraph' }); click('Generate sequence')
    await screen.findByText(/Last generated in demo mode ·/)
    click('Edit intention 1'); fill('Primary purpose', 'Introduce the topic'); await save()
    click('Move intention 1 down'); await waitFor(() => expect(server.get().intentions[1].function_label).toBe('Introduce the topic'))
    await waitFor(() => expect(screen.getByRole('button', { name: '← All drafts' })).toBeEnabled())
    click('← All drafts'); await screen.findByRole('button', { name: 'New paragraph' }); click('New paragraph')
    await screen.findByText(/Last generated in demo mode ·/)
    expect(server.get().target_sentence_count).toBe(3)
    expect(server.get().target_word_min).toBe(60)
    expect(window.location.hash).toBe('#/drafts/1')
    const writes = server.fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(writes).toHaveLength(2)
  })
  it('requires confirmation for replacement and preserves work when generation fails', async () => {
    const server = backend(sampleDraft({ intentions: [item(1)], intention_count: 1 }))
    render(<App />); await screen.findByText('My paragraph'); await open()
    click('Generate sequence'); expect(screen.getByRole('dialog')).toHaveTextContent('saved notes and sentences')
    click('Cancel'); expect(server.fetchMock.mock.calls.filter(([path]) => path.endsWith('/generate'))).toHaveLength(0)
    server.fail({ path: '/generate', status: 502, detail: 'The model returned invalid guidance.' })
    click('Generate sequence'); click('Replace sequence')
    await screen.findByText('The model returned invalid guidance.')
    expect(server.get().intentions[0].id).toBe(1)
    expect(screen.getByRole('button', { name: 'Generate sequence' })).toBeEnabled()
  })
  it('preserves conflict edits and resubmits only after explicitly choosing the latest revision', async () => {
    const server = backend(sampleDraft({ intentions: [item(1)], intention_count: 1 }))
    render(<App />); await screen.findByText('My paragraph'); await open(); click('Edit intention 1')
    fill('Primary purpose', 'My local purpose')
    server.change({ revision: 2, intentions: [{ ...item(1), function_label: 'Other tab purpose', revision: 2 }] })
    fireEvent.submit(screen.getByRole('form', { name: 'Intention details' }))
    await screen.findByRole('heading', { name: 'Saved data changed' })
    expect(screen.getByLabelText('Primary purpose')).toHaveValue('My local purpose')
    expect(screen.getByText('Saved purpose: Other tab purpose')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    click('Keep my edits'); await save()
    expect(server.get().intentions[0].function_label).toBe('My local purpose')
    const calls = server.fetchMock.mock.calls.filter(([path, options]) => path === '/api/intentions/1' && options?.method === 'PATCH')
    expect(calls.map(([, options]) => JSON.parse(String(options?.body)).expected_revision)).toEqual([1, 2])
  })
  it('can use the saved version instead of local settings after a conflict', async () => {
    const server = backend(); render(<App />); await screen.findByText('My paragraph'); await open(); click('Edit settings')
    fill('Topic', 'My local topic'); server.change({ topic: 'Other tab topic', revision: 2 })
    fireEvent.submit(screen.getByRole('form', { name: 'Draft settings' })); await screen.findByRole('heading', { name: 'Saved data changed' })
    click('Use saved version'); expect(screen.getByLabelText('Topic')).toHaveValue('Other tab topic')
    click('Cancel'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('validates partial ranges without sending a request and protects dirty navigation', async () => {
    const server = backend(); render(<App />); await screen.findByText('My paragraph'); click('New draft')
    fill('Title', 'Unsaved'); fill('Topic', 'Some topic'); fill('Minimum words (optional)', '60')
    fireEvent.submit(screen.getByRole('form', { name: 'Draft settings' })); await screen.findByText(/provide both word bounds/)
    expect(server.fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    click('My paragraph'); expect(screen.getByRole('dialog')).toHaveAccessibleName('Leave unsaved changes?')
    click('Cancel'); expect(screen.getByLabelText('Title')).toHaveValue('Unsaved')
    click('My paragraph'); click('Discard and leave'); await screen.findByRole('button', { name: 'Generate sequence' })
  })
  it('adds and deletes an intention with confirmation, compacts positions, and enforces eight in the UI', async () => {
    const server = backend(sampleDraft({ intentions: Array.from({ length: 8 }, (_, index) => item(index + 1, index)), intention_count: 8 }))
    render(<App />); await screen.findByText('My paragraph'); await open()
    expect(screen.getByRole('button', { name: 'Add intention' })).toBeDisabled()
    click('Delete intention 1'); click('Cancel'); expect(server.get().intentions).toHaveLength(8)
    click('Delete intention 1'); click('Delete intention')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add intention' })).toBeEnabled())
    expect(server.get().intentions[0].position).toBe(0)
    click('Add intention'); fill('Primary purpose', 'Close'); fill('Description', 'Bring it together.'); fill('Guiding question', 'What matters?'); await save()
    expect(server.get().intentions.at(-1)?.function_label).toBe('Close')
    expect(screen.getByRole('button', { name: 'Add intention' })).toBeDisabled()
  })
  it('deletes a draft only after confirmation and handles the empty list', async () => {
    backend(); render(<App />); await screen.findByText('My paragraph'); click('Delete draft My paragraph'); click('Cancel')
    expect(screen.getByText('My paragraph')).toBeInTheDocument(); click('Delete draft My paragraph'); click('Delete')
    await screen.findByText('A clear paragraph starts with a plan.')
    expect(screen.queryByText('My paragraph')).not.toBeInTheDocument()
  })
  it('shows readable load failures and retries without replaying writes', async () => {
    const server = backend(); server.fetchMock.mockImplementationOnce(async () => jsonResponse({ status: 'ok' })).mockImplementationOnce(async () => jsonResponse({ detail: 'Local database unavailable.' }, 500))
    render(<App />); await screen.findByText('Local database unavailable.'); click('Retry loading drafts'); await screen.findByText('My paragraph')
    expect(server.fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
  })
  it('ignores a late draft read after navigation to another draft', async () => {
    let resolve!: (value: ReturnType<typeof jsonResponse>) => void
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/health' ? jsonResponse({ status: 'ok' }) : path === '/api/drafts/1' ? new Promise<ReturnType<typeof jsonResponse>>(done => { resolve = done }) : jsonResponse(sampleDraft({ id: 2, title: 'Second draft' }))))
    window.history.replaceState(null, '', '#/drafts/1'); render(<App />)
    await screen.findByText('Loading draft…')
    await act(async () => { window.location.hash = '#/drafts/2'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    await screen.findByRole('heading', { name: 'Second draft' })
    await act(async () => resolve(jsonResponse(sampleDraft({ title: 'Late first draft' }))))
    expect(screen.queryByText('Late first draft')).not.toBeInTheDocument()
  })
  it('blocks duplicate and conflicting actions during generation', async () => {
    const server = backend(); let finish!: () => void
    const original = server.fetchMock.getMockImplementation()!
    server.fetchMock.mockImplementation(async (path, options) => { if (path.endsWith('/generate')) await new Promise<void>(done => { finish = done }); return original(path, options) })
    render(<App />); await screen.findByText('My paragraph'); await open(); click('Generate sequence')
    await screen.findByText('Saving or generating…')
    expect(screen.getByRole('button', { name: 'Edit settings' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add intention' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '← All drafts' })).toBeDisabled()
    await act(async () => finish()); await screen.findByText(/Last generated in demo mode ·/)
    expect(server.fetchMock.mock.calls.filter(([path]) => path.endsWith('/generate'))).toHaveLength(1)
  })
  it('refreshes a possibly committed save before another write and retains local form entries', async () => {
    const server = backend(sampleDraft({ intentions: [item(1)], intention_count: 1 }))
    const original = server.fetchMock.getMockImplementation()!
    let loseResponse = true
    server.fetchMock.mockImplementation(async (path, options) => {
      const response = await original(path, options)
      if (path === '/api/intentions/1' && options?.method === 'PATCH' && loseResponse) { loseResponse = false; throw new TypeError('Connection lost after commit') }
      return response
    })
    render(<App />); await screen.findByText('My paragraph'); await open(); click('Edit intention 1'); fill('Primary purpose', 'Possibly saved')
    fireEvent.submit(screen.getByRole('form', { name: 'Intention details' }))
    await screen.findByRole('button', { name: 'Refresh saved data' })
    expect(screen.getByLabelText('Primary purpose')).toHaveValue('Possibly saved')
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    click('Refresh saved data'); await screen.findByRole('heading', { name: 'Saved data changed' }); click('Use saved version')
    expect(screen.getByLabelText('Primary purpose')).toHaveValue('Possibly saved')
    expect(server.fetchMock.mock.calls.filter(([path, options]) => path === '/api/intentions/1' && options?.method === 'PATCH')).toHaveLength(1)
  })
  it('rejects invalid and unsafe draft URLs without rounding an ID', async () => {
    const server = backend(); window.history.replaceState(null, '', '#/drafts/9007199254740993'); render(<App />)
    expect(screen.getByText('Draft address not found')).toBeInTheDocument()
    expect(server.fetchMock.mock.calls.some(([path]) => path.startsWith('/api/drafts/'))).toBe(false)
  })
})
