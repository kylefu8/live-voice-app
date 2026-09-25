import { appErrorCode } from '../src/app-error-code';

test('uses fixed native recording/audio codes even when the message is absent or generic', () => {
  expect(appErrorCode({ code: 'recording_destroyed', message: null })).toBe(
    'recording_destroyed',
  );
  expect(
    appErrorCode(
      Object.assign(new Error('Generic native failure'), {
        code: 'audio_focus_denied',
      }),
    ),
  ).toBe('audio_focus_denied');
});

test('retains protocol error messages and does not stringify unknown native objects', () => {
  expect(appErrorCode(new Error('voice_http_401'))).toBe('voice_http_401');
  expect(
    appErrorCode({
      message: 'private provider response',
      code: 'EUNSPECIFIED',
    }),
  ).toBe('unknown_error');
});
