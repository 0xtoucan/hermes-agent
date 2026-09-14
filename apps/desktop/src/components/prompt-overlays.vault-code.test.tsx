import type { ServerRequest } from '@hermes/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { PromptOverlays } from '@/components/prompt-overlays'
import { clearAllPrompts, sessionVaultCodeRequest, setVaultCodeRequest } from '@/store/prompts'
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

it('answers the vault-code request with the trimmed code', async () => {
  const request = fakeServerRequest('req-c', 'vault.code.request')
  setVaultCodeRequest({ hint: '', request, requestId: request.id, sessionId: 'session-a', site: 'github.com' })

  render(<PromptOverlays sessionId="session-a" />)
  expect(screen.getByText('Verification code for github.com')).toBeTruthy()
  const input = screen.getByLabelText('Code')
  const submit = screen.getByRole('button', { name: 'Enter code' })
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.change(input, { target: { value: '246 810' } })
  expect(submit).toHaveProperty('disabled', false)
  fireEvent.submit(input.closest('form')!)

  await waitFor(() => expect(request.respond).toHaveBeenCalledOnce())
  expect(request.respond).toHaveBeenCalledWith({ value: '246810' })
  await waitFor(() => expect(sessionVaultCodeRequest('session-a').get()).toBeNull())
})

it('answers an empty code when skipped and clears the card', async () => {
  const request = fakeServerRequest('req-d', 'vault.code.request')
  setVaultCodeRequest({ hint: '', request, requestId: request.id, sessionId: 'session-a', site: 'github.com' })

  render(<PromptOverlays sessionId="session-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

  await waitFor(() => expect(request.respond).toHaveBeenCalledOnce())
  expect(request.respond).toHaveBeenCalledWith({ value: '' })
  await waitFor(() => expect(sessionVaultCodeRequest('session-a').get()).toBeNull())
})
