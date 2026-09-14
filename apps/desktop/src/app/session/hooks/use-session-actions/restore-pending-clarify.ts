import type { GatewayEventPayload } from '@/lib/chat-messages'
import type { ClarifyRequest } from '@/store/clarify'

/** Convert a live server request into the matching clarify tool-call payload. */
export function pendingClarifyToolPayload(request: ClarifyRequest): GatewayEventPayload {
  return {
    args: request.questions?.length
      ? {
          questions: request.questions.map(question => ({
            choices: question.choices ?? undefined,
            multi_select: question.multiSelect || undefined,
            question: question.question
          }))
        }
      : {
          choices: request.choices ?? [],
          ...(request.multiSelect ? { multi_select: true } : {}),
          question: request.question
        },
    tool_id: request.requestId
  }
}
