import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { countWords, LengthSummary } from './LengthSummary'
import { item, sampleDraft } from '../test/fixtures'

describe('length targets', () => {
  it('counts only whitespace-separated sentence words including unfinished text', () => {
    expect(countWords("  don't\nre-write\tthis… ")).toBe(3)
    expect(countWords('  \n\t')).toBe(0)
    const draft = sampleDraft({ target_sentence_count: 6, target_word_min: 120, target_word_max: 180, intentions: [{ ...item(1), sentence_text: "Don't re-write this", user_notes: 'These extra notes do not count' }] })
    render(<LengthSummary settings={draft} draft={draft} />)
    expect(screen.getByText('1 intentions · 3 current words')).toBeInTheDocument()
    expect(screen.getByText('Average planning range: 20.0–30.0 words per sentence.')).toBeInTheDocument()
    expect(screen.getByText(/sequence has 1 intentions/)).toBeInTheDocument()
    expect(screen.getByText(/below the target range/)).toBeInTheDocument()
  })
  it('shows difficult-target and above-range advisories without blocking actions', () => {
    const draft = sampleDraft({ target_word_min: 1, target_word_max: 2, intentions: [{ ...item(1), sentence_text: 'One two three' }] })
    render(<LengthSummary settings={draft} draft={draft} />)
    expect(screen.getByText('Length targets may be difficult for this sentence count.')).toBeInTheDocument()
    expect(screen.getByText(/above the target range/)).toBeInTheDocument()
  })
})
