import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPollPayload,
  createBoundedMessageStore,
  pollCreationMessageFromPayload,
} from './bridge_helpers.js';
import { createOutboundIdTracker } from './outbound_ids.js';
import { createPollUpdateRuntime } from './poll_update_runtime.js';

function pollFixture({ pollId = 'poll-created-by-marta', metadata = { kind: 'poll' } } = {}) {
  const payload = buildPollPayload({
    question: '¿Confirmás?',
    options: ['Approve', 'Deny'],
    selectableCount: 1,
  });
  return {
    key: { id: pollId, remoteJid: '267383306489914@lid', fromMe: true },
    message: pollCreationMessageFromPayload(payload),
    bridgeMetadata: metadata,
  };
}

function runtimeFixture({ decryptPollVote, aggregateVotes, enqueueEvent } = {}) {
  const trackedPollIds = createOutboundIdTracker(16);
  const messageStore = createBoundedMessageStore(16);
  const processedVoteIds = createOutboundIdTracker(16);
  const events = [];
  const runtime = createPollUpdateRuntime({
    trackedPollIds,
    messageStore,
    processedVoteIds,
    decryptPollVote: decryptPollVote || (() => { throw new Error('encrypted path is not used by this fixture'); }),
    getKeyAuthor: (key, meId) => key?.participant || key?.remoteJid || meId,
    getAggregateVotesInPollMessage: aggregateVotes || (({ pollUpdates }) => pollUpdates.map(update => ({
      name: update.vote.choice,
      voters: [update.pollUpdateMessageKey?.participant || update.pollUpdateMessageKey?.remoteJid],
    }))),
    getAccountIds: () => ['999999@lid', '59800000000@s.whatsapp.net'],
    pollAuthorCandidates: () => ['999999@lid', '59800000000@s.whatsapp.net'],
    enqueueEvent: enqueueEvent || (event => events.push(event)),
  });
  return { runtime, trackedPollIds, messageStore, events };
}

function vote({ pollId = 'poll-created-by-marta', voteId, choice, timestamp, fromMe = false }) {
  const key = {
    id: voteId,
    remoteJid: '267383306489914@lid',
    participant: '267383306489914@lid',
    fromMe,
  };
  return {
    key,
    messageTimestamp: timestamp,
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: pollId, remoteJid: key.remoteJid },
        pollUpdateMessageKey: key,
        vote: { selectedOptions: [Buffer.from(choice)], choice },
        senderTimestampMs: timestamp,
      },
    },
  };
}

test('upsert listener accepts a valid tracked poll before fromMe owner gating', () => {
  const { runtime, trackedPollIds, messageStore, events } = runtimeFixture();
  trackedPollIds.remember('poll-created-by-marta');
  messageStore.remember(pollFixture({
    metadata: { kind: 'poll', replyButtonOptionMap: { approve: 'confirmar', deny: 'no' } },
  }));

  const result = runtime.handleUpsert(vote({
    voteId: 'provider-vote-from-me',
    choice: 'Approve',
    timestamp: 1700000000000,
    fromMe: true,
  }));

  assert.deepEqual(result, { handled: true, enqueued: 1, reason: '' });
  assert.equal(events.length, 1);
  assert.equal(events[0].messageId, 'provider-vote-from-me');
  assert.equal(events[0].body, 'confirmar');
  assert.equal(events[0].timestamp, 1700000000);
});

test('upsert listener rejects ordinary outbound ids and invalid cached polls', () => {
  const { runtime, trackedPollIds, messageStore, events } = runtimeFixture();
  const ordinaryOutboundIds = createOutboundIdTracker(16);
  ordinaryOutboundIds.remember('ordinary-text-message');
  messageStore.remember({
    key: { id: 'ordinary-text-message', remoteJid: '267383306489914@lid', fromMe: true },
    message: { conversation: 'ordinary outbound text' },
  });

  const crafted = runtime.handleUpsert(vote({
    pollId: 'ordinary-text-message',
    voteId: 'crafted-vote',
    choice: 'Approve',
    timestamp: 1700000000000,
    fromMe: true,
  }));
  assert.deepEqual(crafted, { handled: true, enqueued: 0, reason: 'foreign_or_invalid_poll' });

  trackedPollIds.remember('invalid-poll');
  messageStore.remember(pollFixture({ pollId: 'invalid-poll', metadata: {} }));
  const invalid = runtime.handleUpsert(vote({
    pollId: 'invalid-poll',
    voteId: 'invalid-vote',
    choice: 'Approve',
    timestamp: 1700000000000,
  }));
  assert.deepEqual(invalid, { handled: true, enqueued: 0, reason: 'foreign_or_invalid_poll' });

  const missingSecret = pollFixture({ pollId: 'missing-secret' });
  delete missingSecret.message.messageContextInfo;
  trackedPollIds.remember('missing-secret');
  messageStore.remember(missingSecret);
  const secretless = runtime.handleUpsert(vote({
    pollId: 'missing-secret',
    voteId: 'secretless-vote',
    choice: 'Approve',
    timestamp: 1700000000000,
  }));
  assert.deepEqual(secretless, { handled: true, enqueued: 0, reason: 'foreign_or_invalid_poll' });
  assert.deepEqual(events, []);
});

test('messages.update listener emits every vote independently and replay is idempotent', () => {
  const { runtime, trackedPollIds, messageStore, events } = runtimeFixture();
  trackedPollIds.remember('poll-created-by-marta');
  messageStore.remember(pollFixture({
    metadata: { kind: 'poll', replyButtonOptionMap: { approve: 'confirmar', deny: 'no' } },
  }));
  const firstVote = vote({ voteId: 'provider-vote-1', choice: 'Approve', timestamp: 1700000000000 });
  const secondVote = vote({ voteId: 'provider-vote-2', choice: 'Deny', timestamp: 1700000001000 });
  const batch = [{
    key: { id: 'poll-created-by-marta', remoteJid: '267383306489914@lid', fromMe: true },
    update: {
      pollUpdates: [
        firstVote.message.pollUpdateMessage,
        secondVote.message.pollUpdateMessage,
      ],
    },
  }];

  assert.deepEqual(runtime.handleUpdates(batch), { handled: true, enqueued: 2, rejected: 0 });
  assert.deepEqual(events.map(event => event.messageId), ['provider-vote-1', 'provider-vote-2']);
  assert.deepEqual(events.map(event => event.body), ['confirmar', 'no']);
  assert.deepEqual(events.map(event => event.timestamp), [1700000000, 1700000001]);

  assert.deepEqual(runtime.handleUpdates(batch), { handled: true, enqueued: 0, rejected: 0 });
  assert.equal(events.length, 2);
});

test('decrypt failure emits nothing and the same provider update remains replayable', () => {
  let failDecrypt = true;
  const { runtime, trackedPollIds, messageStore, events } = runtimeFixture({
    decryptPollVote: () => {
      if (failDecrypt) throw new Error('cannot decrypt yet');
      return { selectedOptions: [Buffer.from('Approve')], choice: 'Approve' };
    },
  });
  trackedPollIds.remember('poll-created-by-marta');
  messageStore.remember(pollFixture({
    metadata: { kind: 'poll', replyButtonOptionMap: { approve: 'confirmar' } },
  }));
  const encrypted = vote({ voteId: 'provider-encrypted-vote', choice: 'Approve', timestamp: 1700000000000, fromMe: true });
  encrypted.message.pollUpdateMessage.vote = {
    encPayload: Buffer.from('ciphertext'),
    encIv: Buffer.from('iv'),
  };

  assert.deepEqual(runtime.handleUpsert(encrypted), {
    handled: true,
    enqueued: 0,
    reason: 'decode_failed',
  });
  assert.deepEqual(events, []);

  failDecrypt = false;
  assert.deepEqual(runtime.handleUpsert(encrypted), { handled: true, enqueued: 1, reason: '' });
  assert.equal(events[0].messageId, 'provider-encrypted-vote');
});

test('empty selection and deselection emit nothing and remain replayable', () => {
  let selected = false;
  const { runtime, trackedPollIds, messageStore, events } = runtimeFixture({
    aggregateVotes: ({ pollUpdates }) => [{
      name: 'Approve',
      voters: selected ? [pollUpdates[0].pollUpdateMessageKey.remoteJid] : [],
    }],
  });
  trackedPollIds.remember('poll-created-by-marta');
  messageStore.remember(pollFixture());
  const deselection = vote({
    voteId: 'provider-selection-change',
    choice: 'Approve',
    timestamp: 1700000000000,
  });

  assert.deepEqual(runtime.handleUpsert(deselection), {
    handled: true,
    enqueued: 0,
    reason: 'empty_selection',
  });
  assert.deepEqual(events, []);

  selected = true;
  assert.deepEqual(runtime.handleUpsert(deselection), { handled: true, enqueued: 1, reason: '' });
  assert.equal(events.length, 1);
});

test('missing provider vote id fails closed and never uses creation id or content hash', () => {
  const { runtime, trackedPollIds, messageStore, events } = runtimeFixture();
  trackedPollIds.remember('poll-created-by-marta');
  messageStore.remember(pollFixture());
  const missingId = vote({ voteId: '', choice: 'Approve', timestamp: 1700000000000 });

  assert.deepEqual(runtime.handleUpsert(missingId), {
    handled: true,
    enqueued: 0,
    reason: 'missing_provider_id',
  });
  assert.deepEqual(events, []);

  const identified = vote({ voteId: 'provider-vote-after-missing', choice: 'Approve', timestamp: 1700000000000 });
  assert.deepEqual(runtime.handleUpsert(identified), { handled: true, enqueued: 1, reason: '' });
  assert.equal(events[0].messageId, 'provider-vote-after-missing');
  assert.deepEqual(runtime.handleUpsert(identified), { handled: true, enqueued: 0, reason: 'replay' });
});

test('an enqueue failure does not consume the provider vote id', () => {
  let failEnqueue = true;
  const events = [];
  const fixture = runtimeFixture({
    enqueueEvent: event => {
      if (failEnqueue) throw new Error('queue unavailable');
      events.push(event);
    },
  });
  fixture.trackedPollIds.remember('poll-created-by-marta');
  fixture.messageStore.remember(pollFixture());
  const identified = vote({
    voteId: 'provider-vote-enqueue-retry',
    choice: 'Approve',
    timestamp: 1700000000000,
  });

  assert.throws(() => fixture.runtime.handleUpsert(identified), /queue unavailable/);
  failEnqueue = false;
  assert.deepEqual(fixture.runtime.handleUpsert(identified), {
    handled: true,
    enqueued: 1,
    reason: '',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].messageId, 'provider-vote-enqueue-retry');
});
