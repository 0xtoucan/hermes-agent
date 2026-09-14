import { afterEach, expect, it, vi } from 'vitest'

import { blockContinuationSend, finishOnboardingAllowance } from '@/store/free-tier-continuation'
import { requestGatewayForAgent } from '@/store/gateway'
import { $onboardingAnswers } from '@/store/onboarding-answers'
import { setSessionOwnerHint } from '@/store/session'

vi.mock('@/store/gateway', async importOriginal => ({
  ...await importOriginal(), requestGatewayForAgent: vi.fn()
}))

const initial = $onboardingAnswers.get()

afterEach(() => {
  $onboardingAnswers.set(initial)
  vi.clearAllMocks()
})

it('ends grace on the owning backend and retries persisted layout completion before another guide send', async () => {
  const owner = { connectionId: 'remote-guide', profile: 'hermes-setup' }
  setSessionOwnerHint('guide', owner)
  vi.mocked(requestGatewayForAgent).mockResolvedValue({ finished: true, continuation_required: false } as never)
  await finishOnboardingAllowance('guide')
  expect(requestGatewayForAgent).toHaveBeenCalledWith('remote-guide', 'hermes-setup', 'free_tier.finish_onboarding', { session_id: 'guide' })
  vi.clearAllMocks()
  $onboardingAnswers.set({ ...initial, layoutSelected: true })
  expect(await blockContinuationSend('guide')).toBe(false)
  expect(vi.mocked(requestGatewayForAgent).mock.calls.map(call => call[2])).toEqual(['free_tier.finish_onboarding', 'free_tier.status'])
})

it('keeps unaccepted work blocked if the global start signal fails', async () => {
  setSessionOwnerHint('guide-failed', { connectionId: 'remote-guide', profile: 'hermes-setup' })
  $onboardingAnswers.set({ ...initial, layoutSelected: true })
  vi.mocked(requestGatewayForAgent).mockRejectedValue(new Error('offline'))
  expect(await blockContinuationSend('guide-failed')).toBe(true)
  expect(requestGatewayForAgent).toHaveBeenCalledTimes(1)
})
