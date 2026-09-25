// A spoken memory answer need not invoke the reasoning backend.
export function completedRoundPath(round, now, quietMs = 3000) {
  if (!round || round.errorCodes?.length || !round.lastAssistantAt || now - round.lastAssistantAt < quietMs) return null;
  if (round.backendStatus === 'working') return null;
  if (round.expectedPhrase && !round.expectedPhraseMatched) return null;
  if (round.expectedPhrase && round.expectedPhraseMatched && round.backendCalls === 0 && round.assistantFragments > 0) return 'voice_memory';
  if (!round.expectedPhrase && round.kind !== 'search' && round.backendCalls === 0 && round.assistantFragments > 0 &&
      round.promptEndedAt > 0 && now - round.promptEndedAt >= quietMs) return 'voice_direct';
  if (round.backendResults > 0 && round.assistantAfterResultFragments > 0 && round.backendStatus === 'done') return 'backend';
  return null;
}
