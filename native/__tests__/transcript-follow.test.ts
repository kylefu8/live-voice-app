import {
  beginTranscriptDrag,
  beginTranscriptMomentum,
  completeTranscriptAutoScroll,
  createTranscriptFollowState,
  endTranscriptDrag,
  endTranscriptMomentum,
  observeTranscriptUserScroll,
  onTranscriptContentSizeChange,
  onTranscriptLayout,
} from '../src/transcript-follow';

test('a new session follows the newest content by default', () => {
  const state = createTranscriptFollowState();
  const transition = onTranscriptContentSizeChange(state);

  expect(transition.state.following).toBe(true);
  expect(transition.shouldScrollToEnd).toBe(true);
});

test('manual upward scrolling keeps the viewport while messages are appended', () => {
  let state = beginTranscriptDrag(createTranscriptFollowState());
  state = observeTranscriptUserScroll(state, 160);
  const transition = onTranscriptContentSizeChange(state);

  expect(transition.state.following).toBe(false);
  expect(transition.state.pendingAutoScroll).toBe(false);
  expect(transition.shouldScrollToEnd).toBe(false);
});

test('returning within 32pt of the bottom resumes live follow', () => {
  let state = beginTranscriptDrag(createTranscriptFollowState());
  state = observeTranscriptUserScroll(state, 200);
  state = observeTranscriptUserScroll(state, 32);
  const transition = endTranscriptDrag(state, 32);

  expect(transition.state.following).toBe(true);
  expect(transition.shouldScrollToEnd).toBe(false);

  const appended = onTranscriptContentSizeChange(transition.state);
  expect(appended.shouldScrollToEnd).toBe(true);
});

test('programmatic scroll events while idle do not disable follow', () => {
  const initial = createTranscriptFollowState();
  const afterProgrammaticScroll = observeTranscriptUserScroll(initial, 240);

  expect(afterProgrammaticScroll).toEqual(initial);
});

test('content arriving while a finger is held at the bottom waits until release', () => {
  let state = beginTranscriptDrag(createTranscriptFollowState(), 1500);
  state = observeTranscriptUserScroll(state, 0, 1500);
  const appended = onTranscriptContentSizeChange(state);

  expect(appended.state.following).toBe(true);
  expect(appended.shouldScrollToEnd).toBe(false);

  // The content became taller, so the distance grew even though the finger
  // and viewport offset did not move. This is still live-following.
  const unchangedOffset = observeTranscriptUserScroll(
    appended.state,
    100,
    1500,
  );
  const released = endTranscriptDrag(unchangedOffset, 100, 1500);
  expect(released.shouldScrollToEnd).toBe(true);
});

test('an upward fling remains manual through momentum and only resumes at bottom', () => {
  let state = beginTranscriptDrag(createTranscriptFollowState());
  state = observeTranscriptUserScroll(state, 180);
  state = endTranscriptDrag(state, 180).state;
  state = beginTranscriptMomentum(state);
  state = observeTranscriptUserScroll(state, 84);
  let ended = endTranscriptMomentum(state, 84);

  expect(ended.state.following).toBe(false);
  expect(ended.shouldScrollToEnd).toBe(false);

  state = beginTranscriptDrag(ended.state);
  state = observeTranscriptUserScroll(state, 0);
  ended = endTranscriptDrag(state, 0);
  expect(ended.state.following).toBe(true);
});

test('auto-scroll completion clears only the pending request', () => {
  const state = createTranscriptFollowState();
  const completed = completeTranscriptAutoScroll(state);

  expect(completed.following).toBe(true);
  expect(completed.pendingAutoScroll).toBe(false);
});

test('bottom rubber-band settling does not turn following off', () => {
  let state = beginTranscriptDrag(createTranscriptFollowState(), 510);
  state = observeTranscriptUserScroll(state, 0, 525);
  const settled = endTranscriptDrag(state, 0, 500);
  expect(settled.state.following).toBe(true);
  expect(onTranscriptContentSizeChange(settled.state).shouldScrollToEnd).toBe(true);
});

test('a viewport resize re-snaps a following transcript after prior auto-scroll', () => {
  const completed = completeTranscriptAutoScroll(createTranscriptFollowState());
  const resized = onTranscriptLayout(completed);

  expect(resized.state.following).toBe(true);
  expect(resized.state.pendingAutoScroll).toBe(true);
  expect(resized.shouldScrollToEnd).toBe(true);
});
