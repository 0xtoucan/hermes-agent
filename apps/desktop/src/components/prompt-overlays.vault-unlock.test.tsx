import type { ServerRequest } from '@hermes/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { PromptOverlays } from '@/components/prompt-overlays'
import { clearAllPrompts, sessionVaultUnlockRequest, setVaultUnlockRequest } from '@/store/prompts'
import { stubResizeObserver } from '@/test/jsdom'

function fakeServerRequest(id: string, method: string): ServerRequest {
  return {
    fail: vi.fn(),
    id,
    method,
    notify: vi.fn(),
    params: {},
    respond: vi.fn(),
    sessionId: 'session-a'
  }
}

stubResizeObserver()

afterEach(() => {
  cleanup()
  clearAllPrompts()
  vi.clearAllMocks()
})

it('answers the vault-unlock request with the master password', async () => {
  const request = fakeServerRequest('req-a', 'vault.unlock.request')
  setVaultUnlockRequest({
    backend: 'bitwarden',
    displayName: 'Bitwarden',
    request,
    requestId: request.id,
    sessionId: 'session-a'
  })

  render(<PromptOverlays sessionId="session-a" />)
  const input = screen.getByPlaceholderText('Master password')
  fireEvent.change(input, { target: { value: 'fixture-master' } })
  fireEvent.submit(input.closest('form')!)

  await waitFor(() => expect(request.respond).toHaveBeenCalledOnce())
  expect(request.respond).toHaveBeenCalledWith({ value: 'fixture-master' })
  await waitFor(() => expect(sessionVaultUnlockRequest('session-a').get()).toBeNull())
})

it('answers an empty password when kept locked and clears the card', async () => {
  const request = fakeServerRequest('req-b', 'vault.unlock.request')
  setVaultUnlockRequest({
    backend: 'bitwarden',
    displayName: 'Bitwarden',
    request,
    requestId: request.id,
    sessionId: 'session-a'
  })

  render(<PromptOverlays sessionId="session-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Keep locked' }))

  await waitFor(() => expect(request.respond).toHaveBeenCalledOnce())
  expect(request.respond).toHaveBeenCalledWith({ value: '' })
  await waitFor(() => expect(sessionVaultUnlockRequest('session-a').get()).toBeNull())
})
