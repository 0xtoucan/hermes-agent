import type { ServerRequest } from '@hermes/shared'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearAllPrompts, clearSecretRequest, clearSudoRequest, setSecretRequest, setSudoRequest } from '@/store/prompts'

import { PromptOverlays } from './prompt-overlays'

function fakeServerRequest(id: string, method: string): ServerRequest {
  return {
    fail: vi.fn(),
    id,
    method,
    notify: vi.fn(),
    params: {},
    respond: vi.fn(),
    sessionId: 's1'
  }
}

function renderPrompts(sessionId: string | null = 's1') {
  render(
    <I18nProvider configClient={null}>
      <PromptOverlays sessionId={sessionId} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  clearAllPrompts()
  vi.clearAllMocks()
})

describe('PromptOverlays', () => {
  it('unmounts the sudo dialog after matching request cancellation', async () => {
    const request = fakeServerRequest('sudo-1', 'sudo.request')

    setSudoRequest({ request, requestId: request.id, sessionId: request.sessionId })
    renderPrompts()

    expect(screen.getByText('Administrator password')).toBeTruthy()

    clearSudoRequest(request.sessionId, request.id)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request.respond).not.toHaveBeenCalled()
  })

  it('unmounts the secret dialog after matching request cancellation', async () => {
    const request = fakeServerRequest('secret-1', 'secret.request')

    setSecretRequest({
      envVar: 'TEST_SECRET',
      prompt: 'Paste a secret',
      request,
      requestId: request.id,
      sessionId: request.sessionId
    })
    renderPrompts()

    expect(screen.getByText('TEST_SECRET')).toBeTruthy()

    clearSecretRequest(request.sessionId, request.id)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request.respond).not.toHaveBeenCalled()
  })
})
