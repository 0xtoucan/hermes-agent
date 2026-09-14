import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { requestGatewayForAgent } from '@/store/gateway'
import { $onboardingAnswers, DEFAULT_ANSWERS, loadAnswers } from '@/store/onboarding-answers'
import { $activeSessionId, $selectedStoredSessionId, setSessionOwnerHint } from '@/store/session'

import { LayoutCard } from './setup'

vi.mock('@/store/gateway', async importOriginal => ({
  ...await importOriginal(), requestGatewayForAgent: vi.fn(async () => ({ finished: true }))
}))
vi.mock('@/components/onboarding-chat/assembly', async importOriginal => ({
  ...await importOriginal(), assembleChatOnboarding: vi.fn()
}))

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $onboardingAnswers.set(DEFAULT_ANSWERS)
})

it('starts global metering at layout selection without needing Continue or handoff', async () => {
  setSessionOwnerHint('setup-guide', { connectionId: 'setup-remote', profile: 'hermes-setup' })
  $activeSessionId.set('setup-guide')
  $selectedStoredSessionId.set('setup-guide')
  $onboardingAnswers.set(DEFAULT_ANSWERS)
  render(<LayoutCard attrs={{}} locked={false} />)
  const choices = screen.getAllByRole('button').filter(button => button.textContent !== 'Continue')
  expect(choices.length).toBeGreaterThan(0)
  fireEvent.click(choices[0])
  await waitFor(() => expect(requestGatewayForAgent).toHaveBeenCalledWith(
    'setup-remote', 'hermes-setup', 'free_tier.finish_onboarding', { session_id: 'setup-guide' }
  ))
  expect(loadAnswers().layoutSelected).toBe(true)
  expect(loadAnswers().committed).not.toContain('layout')
})
