import {
  buildPollUpdateEvent,
  getMessageContent,
  pollCreationMessageSecret,
  pollUpdateForAggregation,
  pollUpdateProviderMessageId,
} from './bridge_helpers.js';

function hasPollCreationMessage(pollCreation) {
  const message = pollCreation?.message || {};
  return !!(
    message.pollCreationMessage
    || message.pollCreationMessageV2
    || message.pollCreationMessageV3
  );
}

export function validTrackedPollCreation({ pollId, trackedPollIds, messageStore }) {
  if (!pollId || !trackedPollIds?.has?.(pollId)) return null;
  const pollCreation = messageStore?.get?.(pollId);
  if (
    !pollCreation
    || pollCreation.bridgeMetadata?.kind !== 'poll'
    || !hasPollCreationMessage(pollCreation)
    || !pollCreationMessageSecret(pollCreation)
  ) {
    return null;
  }
  return pollCreation;
}

function selectedPollOptions(aggregation) {
  const selected = [];
  for (const option of aggregation || []) {
    if ((option.voters || []).length > 0 && option.name && option.name !== 'Unknown') {
      selected.push(option.name);
    }
  }
  return selected;
}

export function createPollUpdateRuntime({
  trackedPollIds,
  messageStore,
  processedVoteIds,
  decryptPollVote,
  getKeyAuthor,
  getAggregateVotesInPollMessage,
  getAccountIds = () => [],
  pollAuthorCandidates = () => [],
  enqueueEvent = () => {},
  onDiagnostic = () => {},
  onDecodeError = () => {},
}) {
  function processPollUpdate({ sourcePath, pollId, pollCreation, pollUpdateMessage, updateKey, eventKey, providerMessageId, timestamp }) {
    const stableProviderMessageId = pollUpdateProviderMessageId({
      update: { pollUpdates: [{ ...pollUpdateMessage, pollUpdateMessageKey: pollUpdateMessage.pollUpdateMessageKey || updateKey }] },
      providerMessageId,
    });
    if (!stableProviderMessageId) return 'missing_provider_id';

    let aggregation = [];
    let normalizedUpdate;
    try {
      const accountIds = getAccountIds().filter(Boolean);
      normalizedUpdate = pollUpdateForAggregation({
        pollUpdateMessage,
        pollUpdateMessageKey: updateKey,
        pollCreation,
        decryptPollVote,
        getKeyAuthor,
        meId: accountIds[0] || 'me',
        pollCreatorJids: pollAuthorCandidates(
          pollUpdateMessage.pollCreationMessageKey,
          eventKey,
          pollCreation.key,
        ),
        voterJids: pollAuthorCandidates(updateKey, pollUpdateMessage.pollUpdateMessageKey),
      });
      if (!normalizedUpdate) return 'decode_failed';
      aggregation = getAggregateVotesInPollMessage({
        message: pollCreation.message,
        pollUpdates: [normalizedUpdate],
      });
    } catch (error) {
      onDecodeError({ sourcePath, pollId, error });
      return 'decode_failed';
    }

    const selectedOptions = selectedPollOptions(aggregation);
    onDiagnostic({
      sourcePath,
      pollId,
      pollCreation,
      pollUpdates: [normalizedUpdate],
      selectedOptions,
      aggregation,
    });
    if (selectedOptions.length === 0) return 'empty_selection';
    const event = buildPollUpdateEvent({
      key: eventKey,
      update: { pollUpdates: [normalizedUpdate] },
      selectedOptions,
      aggregation,
      replyButtonOptionMap: pollCreation.bridgeMetadata?.replyButtonOptionMap,
      providerMessageId: stableProviderMessageId,
      timestamp,
    });
    if (!event) return 'missing_provider_id';
    if (processedVoteIds?.has?.(event.messageId)) return 'replay';
    enqueueEvent(event);
    processedVoteIds?.remember?.(event.messageId);
    return 'enqueued';
  }

  function handleUpsert(msg) {
    const pollUpdateMessage = getMessageContent(msg)?.pollUpdateMessage;
    if (!pollUpdateMessage) return { handled: false, enqueued: 0, reason: '' };

    const pollId = String(pollUpdateMessage.pollCreationMessageKey?.id || '');
    const pollCreation = validTrackedPollCreation({ pollId, trackedPollIds, messageStore });
    if (!pollCreation) return { handled: true, enqueued: 0, reason: 'foreign_or_invalid_poll' };

    const chatId = msg?.key?.remoteJid || pollCreation.key?.remoteJid || '';
    const senderId = msg?.key?.participant || chatId;
    const eventKey = {
      ...pollUpdateMessage.pollCreationMessageKey,
      id: pollId,
      remoteJid: pollUpdateMessage.pollCreationMessageKey?.remoteJid || chatId,
      participant: pollUpdateMessage.pollCreationMessageKey?.participant || senderId,
    };
    const outcome = processPollUpdate({
      sourcePath: 'messages.upsert',
      pollId,
      pollCreation,
      pollUpdateMessage,
      updateKey: msg.key,
      eventKey,
      providerMessageId: msg?.key?.id,
      timestamp: pollUpdateMessage.senderTimestampMs || msg?.messageTimestamp,
    });
    return { handled: true, enqueued: outcome === 'enqueued' ? 1 : 0, reason: outcome === 'enqueued' ? '' : outcome };
  }

  function handleUpdates(updates) {
    let enqueued = 0;
    let rejected = 0;
    for (const { key, update } of updates || []) {
      for (const pollUpdateMessage of update?.pollUpdates || []) {
        const pollId = String(pollUpdateMessage.pollCreationMessageKey?.id || key?.id || '');
        const pollCreation = validTrackedPollCreation({ pollId, trackedPollIds, messageStore });
        if (!pollCreation) {
          rejected += 1;
          continue;
        }
        const eventKey = {
          ...(pollUpdateMessage.pollCreationMessageKey || key || {}),
          id: pollId,
          remoteJid: pollUpdateMessage.pollCreationMessageKey?.remoteJid || key?.remoteJid || pollCreation.key?.remoteJid || '',
          participant: pollUpdateMessage.pollCreationMessageKey?.participant || key?.participant || '',
        };
        const outcome = processPollUpdate({
          sourcePath: 'messages.update',
          pollId,
          pollCreation,
          pollUpdateMessage,
          updateKey: pollUpdateMessage.pollUpdateMessageKey,
          eventKey,
          providerMessageId: pollUpdateMessage.pollUpdateMessageKey?.id,
          timestamp: pollUpdateMessage.senderTimestampMs,
        });
        if (outcome === 'enqueued') {
          enqueued += 1;
        } else if (outcome !== 'replay') {
          rejected += 1;
        }
      }
    }
    return { handled: true, enqueued, rejected };
  }

  return { handleUpsert, handleUpdates };
}
