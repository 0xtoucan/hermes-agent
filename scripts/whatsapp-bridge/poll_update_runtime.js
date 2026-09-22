import {
  buildPollUpdateEvent,
  getMessageContent,
  pollCreationMessageSecret,
  pollUpdateForAggregation,
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

function selectedPollOptions(aggregation, pollUpdateMessage) {
  const selected = [];
  for (const option of aggregation || []) {
    if ((option.voters || []).length > 0 && option.name && option.name !== 'Unknown') {
      selected.push(option.name);
    }
  }
  if (selected.length > 0) return selected;
  return (pollUpdateMessage?.vote?.selectedOptions || [])
    .map(option => String(option))
    .filter(Boolean);
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
    let aggregation = [];
    let normalizedUpdate = pollUpdateMessage;
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
      }) || pollUpdateMessage;
      aggregation = getAggregateVotesInPollMessage({
        message: pollCreation.message,
        pollUpdates: [normalizedUpdate],
      });
    } catch (error) {
      onDecodeError({ sourcePath, pollId, error });
    }

    const selectedOptions = selectedPollOptions(aggregation, normalizedUpdate);
    onDiagnostic({
      sourcePath,
      pollId,
      pollCreation,
      pollUpdates: [normalizedUpdate],
      selectedOptions,
      aggregation,
    });
    const event = buildPollUpdateEvent({
      key: eventKey,
      update: { pollUpdates: [normalizedUpdate] },
      selectedOptions,
      aggregation,
      replyButtonOptionMap: pollCreation.bridgeMetadata?.replyButtonOptionMap,
      providerMessageId,
      timestamp,
    });
    if (processedVoteIds?.has?.(event.messageId)) return false;
    processedVoteIds?.remember?.(event.messageId);
    enqueueEvent(event);
    return true;
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
    const enqueued = processPollUpdate({
      sourcePath: 'messages.upsert',
      pollId,
      pollCreation,
      pollUpdateMessage,
      updateKey: msg.key,
      eventKey,
      providerMessageId: msg?.key?.id,
      timestamp: pollUpdateMessage.senderTimestampMs || msg?.messageTimestamp,
    });
    return { handled: true, enqueued: enqueued ? 1 : 0, reason: enqueued ? '' : 'replay' };
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
        if (processPollUpdate({
          sourcePath: 'messages.update',
          pollId,
          pollCreation,
          pollUpdateMessage,
          updateKey: pollUpdateMessage.pollUpdateMessageKey,
          eventKey,
          providerMessageId: pollUpdateMessage.pollUpdateMessageKey?.id,
          timestamp: pollUpdateMessage.senderTimestampMs,
        })) {
          enqueued += 1;
        }
      }
    }
    return { handled: true, enqueued, rejected };
  }

  return { handleUpsert, handleUpdates };
}
