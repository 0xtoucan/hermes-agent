import type { ServerRequest } from '@hermes/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { PromptOverlays } from '@/components/prompt-overlays'
import { clearAllPrompts, sessionVaultSaveLoginRequest, setVaultSaveLoginRequest } from '@/store/prompts'
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

it('answers the vault-login request with the encoded login', async () => {
  const request = fakeServerRequest('req-s', 'vault.save_login.request')
  setVaultSaveLoginRequest({
    origin: 'https://github.com',
    request,
    requestId: request.id,
    sessionId: 'session-a',
    site: 'github.com'
  })

  render(<PromptOverlays sessionId="session-a" />)
  expect(screen.getByText('Save your github.com login?')).toBeTruthy()
  const identifier = screen.getByLabelText('Email or username')
  const password = screen.getByLabelText('Password')
  const submit = screen.getByRole('button', { name: 'Save & sign in' })
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.change(identifier, { target: { value: 'tek@acme.test' } })
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.change(password, { target: { value: 'fixture-pw' } })
  expect(submit).toHaveProperty('disabled', false)
  fireEvent.submit(password.closest('form')!)

  await waitFor(() => expect(request.respond).toHaveBeenCalledOnce())
  expect(request.respond).toHaveBeenCalledWith({
    value: JSON.stringify({ identifier: 'tek@acme.test', password: 'fixture-pw' })
  })
  await waitFor(() => expect(sessionVaultSaveLoginRequest('session-a').get()).toBeNull())
})

it("answers an empty login when saving is declined and clears the card", async () => {
  const request = fakeServerRequest('req-d', 'vault.save_login.request')
  setVaultSaveLoginRequest({
    origin: 'https://github.com',
    request,
    requestId: request.id,
    sessionId: 'session-a',
    site: 'github.com'
  })

  render(<PromptOverlays sessionId="session-a" />)
  fireEvent.click(screen.getByRole('button', { name: "Don't save" }))

  await waitFor(() => expect(request.respond).toHaveBeenCalledOnce())
  expect(request.respond).toHaveBeenCalledWith({ value: '' })
  await waitFor(() => expect(sessionVaultSaveLoginRequest('session-a').get()).toBeNull())
})
