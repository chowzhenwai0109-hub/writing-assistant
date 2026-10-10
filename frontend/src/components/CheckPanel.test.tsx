import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CheckPanel } from './CheckPanel'
import { checkFingerprint } from '../api/hintsContext'
import { item, sampleDraft } from '../test/fixtures'
import type { CheckOutput } from '../types/writing'

const check = { busy: false, error: null, needsRefresh: false, get: vi.fn(), invalidate: vi.fn(), reconciled: vi.fn() }
describe('saved check presentation', () => {
  it.each(['yes', 'partly', 'no'] as const)('renders advisory %s and persisted demo provenance without inserting writing', async verdict => {
    const result: CheckOutput = { fulfils_intention: verdict, summary: 'Review summary.', issues: [{ type: 'other', message: 'Clarify meaning.', suggestion: 'Name the referent.' }] }
    const draft = sampleDraft({ intentions: [{ ...item(1), status: 'checked', sentence_text: 'Writer text', last_check_json: { result, mode: 'fake' } }] })
    draft.intentions[0].last_check_fingerprint = await checkFingerprint(draft, 1)
    const props = { draft, id: 1, hidden: false, check, onRefresh: vi.fn() }
    const f = render(<CheckPanel {...props} />)
    await screen.findByText(`Fulfils intention: ${verdict}`); expect(screen.getByText(/Demo check/)).toBeInTheDocument()
    expect(screen.getByText('Name the referent.')).toBeInTheDocument(); expect(screen.queryByRole('textbox')).toBeNull()
    f.rerender(<CheckPanel {...props} hidden />); expect(screen.queryByText('Review summary.')).toBeNull()
    f.rerender(<CheckPanel {...props} />); await screen.findByText('Review summary.')
    const changed = { ...draft, topic: 'Changed context' }
    f.rerender(<CheckPanel {...props} draft={changed} />)
    await waitFor(() => expect(screen.queryByText('Review summary.')).toBeNull())
  })
})
