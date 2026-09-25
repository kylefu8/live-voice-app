/** Native promises may carry their useful fixed code separately from message. */
export function appErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      /^(audio|recording|voice|backend|qr)_[a-z0-9_]+$/.test(code)
    )
      return code;
  }
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown_error';
}
