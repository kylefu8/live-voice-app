import test from 'node:test';
import assert from 'node:assert/strict';
import {completedRoundPath} from '../scripts/stress-round.mjs';

const memory = {lastAssistantAt: 1000, expectedPhrase: 'cedar seven', expectedPhraseMatched: true, backendCalls: 0,
  assistantFragments: 4, backendStatus: 'idle', errorCodes: []};

test('a correct direct spoken memory answer completes without a backend request', () => {
  assert.equal(completedRoundPath(memory, 4000), 'voice_memory');
  assert.equal(completedRoundPath({...memory, expectedPhraseMatched: false}, 4000), null);
  assert.equal(completedRoundPath({...memory, assistantFragments: 0}, 4000), null);
  assert.equal(completedRoundPath({...memory, expectedPhraseMatched: false, backendCalls: 1,
    backendResults: 1, assistantAfterResultFragments: 1, backendStatus: 'done'}, 4000), null);
});
test('an active or failed backend cannot pass through the direct-answer exception', () => {
  assert.equal(completedRoundPath({...memory, backendStatus: 'working'}, 4000), null);
  assert.equal(completedRoundPath({...memory, backendCalls: 1}, 4000), null);
  assert.equal(completedRoundPath({...memory, errorCodes: ['backend_timeout']}, 4000), null);
});
test('backend completion needs speech after its result and a quiet interval', () => {
  const round = {...memory, expectedPhrase: '', backendCalls: 1, backendResults: 1, backendStatus: 'done', assistantAfterResultFragments: 1};
  assert.equal(completedRoundPath(round, 4000), 'backend');
  assert.equal(completedRoundPath(round, 2000), null);
  assert.equal(completedRoundPath({...round, assistantAfterResultFragments: 0}, 4000), null);
});

test('ordinary direct replies are separate from required backend searches and verified memory', () => {
  const direct = {...memory, kind: 'speaking', expectedPhrase: '', expectedPhraseMatched: false, promptEndedAt: 1000};
  assert.equal(completedRoundPath(direct, 4000), 'voice_direct');
  assert.equal(completedRoundPath(direct, 2000), null);
  assert.equal(completedRoundPath({...direct, kind: 'search'}, 4000), null);
  assert.equal(completedRoundPath({...direct, expectedPhrase: 'required answer'}, 4000), null);
});
