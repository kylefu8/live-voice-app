/** A short deliberate swipe snaps fully open; button count must not make it harder. */
export function shouldKeepHistoryActionsOpen(
  startedOpen: boolean,
  dx: number,
  velocityX: number,
  actionWidth: number,
): boolean {
  if (actionWidth <= 0) return false;
  const distance = Math.min(48, actionWidth / 3);
  if (startedOpen) return !(dx >= distance || (dx > 12 && velocityX > 0.35));
  return dx <= -distance || (dx < -12 && velocityX < -0.35);
}
