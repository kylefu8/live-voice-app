export const TRANSCRIPT_BOTTOM_THRESHOLD = 32;

export type TranscriptFollowPhase = 'idle' | 'dragging' | 'momentum';

export type TranscriptFollowState = {
  following: boolean;
  phase: TranscriptFollowPhase;
  pendingAutoScroll: boolean;
  /** Last offset reported by a user gesture, used to ignore content growth. */
  lastUserOffsetY: number | null;
};

export type TranscriptFollowTransition = {
  state: TranscriptFollowState;
  shouldScrollToEnd: boolean;
};

export function createTranscriptFollowState(): TranscriptFollowState {
  return {
    // A new session starts at the newest transcript position.
    following: true,
    phase: 'idle',
    pendingAutoScroll: true,
    lastUserOffsetY: null,
  };
}

export function beginTranscriptDrag(
  state: TranscriptFollowState,
  offsetY?: number,
): TranscriptFollowState {
  return {
    ...state,
    phase: 'dragging',
    lastUserOffsetY: offsetY ?? state.lastUserOffsetY,
  };
}

export function beginTranscriptMomentum(
  state: TranscriptFollowState,
): TranscriptFollowState {
  return {...state, phase: 'momentum'};
}

/**
 * Apply a user-originated scroll position. Scroll events received while idle
 * are programmatic scroll events and must not change follow mode.
 */
export function observeTranscriptUserScroll(
  state: TranscriptFollowState,
  distanceFromBottom: number,
  offsetY?: number,
): TranscriptFollowState {
  if (state.phase === 'idle') return state;
  const previousOffsetY = state.lastUserOffsetY;
  const offsetDelta =
    offsetY === undefined || previousOffsetY === null
      ? undefined
      : offsetY - previousOffsetY;
  const movedUp = offsetDelta !== undefined && offsetDelta < -0.5;
  const atBottom = distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD;
  const manualMoveDetected =
    movedUp || (offsetDelta === undefined && !atBottom);
  return {
    ...state,
    // A larger distance can be caused by content appended below an unchanged
    // finger position. Only an actual upward offset movement pauses follow.
    // When no offset is available, retain the older distance-only behavior.
    following: atBottom
      ? true
      : manualMoveDetected
      ? false
      : offsetDelta === undefined
      ? atBottom
      : state.following || atBottom,
    // A manual upward move cancels an old pending scroll. Returning to the
    // bottom does not need a second scroll if the viewport is already there.
    pendingAutoScroll: manualMoveDetected && !atBottom
      ? false
      : state.pendingAutoScroll,
    lastUserOffsetY: offsetY ?? state.lastUserOffsetY,
  };
}

export function endTranscriptDrag(
  state: TranscriptFollowState,
  distanceFromBottom: number,
  offsetY?: number,
): TranscriptFollowTransition {
  const observed = observeTranscriptUserScroll(state, distanceFromBottom, offsetY);
  const next = {...observed, phase: 'idle' as const};
  return {
    state: next,
    shouldScrollToEnd: next.following && next.pendingAutoScroll,
  };
}

export function endTranscriptMomentum(
  state: TranscriptFollowState,
  distanceFromBottom?: number,
  offsetY?: number,
): TranscriptFollowTransition {
  const observed =
    distanceFromBottom === undefined
      ? state
      : observeTranscriptUserScroll(state, distanceFromBottom, offsetY);
  const next = {...observed, phase: 'idle' as const};
  return {
    state: next,
    shouldScrollToEnd: next.following && next.pendingAutoScroll,
  };
}

/**
 * Record that children changed. Appending while the user is away from the
 * bottom leaves the native ScrollView's current offset untouched. When the
 * user is following the newest text, the component schedules one bottom snap.
 */
export function onTranscriptContentSizeChange(
  state: TranscriptFollowState,
): TranscriptFollowTransition {
  const next = {
    ...state,
    pendingAutoScroll: state.following,
  };
  return {
    state: next,
    shouldScrollToEnd: next.following && next.phase === 'idle',
  };
}

export function onTranscriptLayout(
  state: TranscriptFollowState,
): TranscriptFollowTransition {
  const shouldScrollToEnd = state.following && state.phase === 'idle';
  const next = shouldScrollToEnd
    ? {...state, pendingAutoScroll: true}
    : state;
  return {
    state: next,
    // A viewport resize can move the bottom even after the previous auto
    // scroll completed, so following mode must request a fresh snap.
    shouldScrollToEnd,
  };
}

export function completeTranscriptAutoScroll(
  state: TranscriptFollowState,
): TranscriptFollowState {
  return {...state, pendingAutoScroll: false};
}
