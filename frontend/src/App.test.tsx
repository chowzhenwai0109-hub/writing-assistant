import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HealthStatus } from './components/HealthStatus'

describe('backend connection', () => {
  it('shows the status received through the relative API route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<HealthStatus />)
    expect(await screen.findByText('backend: ok')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('shows an actionable error when the backend cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Could not connect to the backend.')))
    render(<HealthStatus />)
    expect(await screen.findByText('Could not connect to the backend.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeEnabled()
    expect(screen.queryByText('backend: ok')).not.toBeInTheDocument()
  })
})
