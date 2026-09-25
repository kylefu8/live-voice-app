import {shouldKeepHistoryActionsOpen} from '../src/history-swipe';

test.each([176, 264])('an ordinary 80pt swipe stays open with %ipt of actions', width => {
  expect(shouldKeepHistoryActionsOpen(false, -80, -0.05, width)).toBe(true);
});
test('a short flick opens but a small slow movement snaps back', () => {
  expect(shouldKeepHistoryActionsOpen(false, -25, -0.5, 264)).toBe(true);
  expect(shouldKeepHistoryActionsOpen(false, -20, -0.05, 264)).toBe(false);
  expect(shouldKeepHistoryActionsOpen(false, -5, -0.6, 264)).toBe(false);
});
test('open actions stay visible until a deliberate rightward close', () => {
  expect(shouldKeepHistoryActionsOpen(true, 10, 0.01, 264)).toBe(true);
  expect(shouldKeepHistoryActionsOpen(true, 55, 0.01, 264)).toBe(false);
  expect(shouldKeepHistoryActionsOpen(true, 25, 0.5, 264)).toBe(false);
  expect(shouldKeepHistoryActionsOpen(true, -30, -0.5, 264)).toBe(true);
});
