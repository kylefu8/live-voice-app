import {
  ErrorCode,
  ProtocolError,
  authHeaders,
  buildBackendInstructions,
  buildVoiceInstructions,
  buildVoiceUpdateInstructions,
  liveHttpUrl,
  liveWebSocketUrl,
  responsesHttpUrl,
  validateBackendPreferences,
  validateVoicePreferences,
} from '../src/protocol';
import type {BackendPreferences, VoicePreferences} from '../src/types';

const voice: VoicePreferences = {
  voice: 'marin',
  tone: 'natural',
  intonation: 'natural',
  pace: 'normal',
  minutes: 10,
  instructions: '',
};

describe('Live protocol helpers', () => {
  test('normalizes known resource roots consistently for Live and Responses', () => {
    expect(liveHttpUrl('https://speech.example.openai.azure.com/')).toBe('https://speech.example.openai.azure.com/openai/v1/live/sessions');
    expect(liveWebSocketUrl('https://speech.example.openai.azure.com/openai')).toBe('wss://speech.example.openai.azure.com/openai/v1/live/sessions');
    expect(responsesHttpUrl('https://speech.example.openai.azure.com')).toBe('https://speech.example.openai.azure.com/openai/v1/responses');
    expect(liveHttpUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/live/sessions');
    expect(liveHttpUrl('https://gateway.example/custom')).toBe('https://gateway.example/custom/live/sessions');
    expect(liveHttpUrl('https://gateway.example')).toBe('https://gateway.example/live/sessions');
  });
  test('builds the configured Live paths without exposing credentials', () => {
    expect(liveHttpUrl('https://voice.example/v1')).toBe('https://voice.example/v1/live/sessions');
    expect(liveHttpUrl('https://voice.example/v1/live/sessions')).toBe('https://voice.example/v1/live/sessions');
    expect(liveWebSocketUrl('https://voice.example/v1')).toBe('wss://voice.example/v1/live/sessions');
    expect(authHeaders('bearer', 'synthetic-key')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer synthetic-key',
    });
  });

  test('rejects insecure endpoints and overly long style text', () => {
    expect(() => liveHttpUrl('http://voice.example/v1')).toThrow(ProtocolError);
    expect(() => liveHttpUrl('https://voice.example/v1?key=secret')).toThrow(ProtocolError);
    expect(() => buildVoiceInstructions('practice', 'zh', {...voice, instructions: 'x'.repeat(900)})).toThrow(
      expect.objectContaining({code: ErrorCode.STYLE_TOO_LONG}),
    );
  });

  test('builds bounded hot style instructions that explicitly supersede earlier style updates', () => {
    const update = buildVoiceUpdateInstructions('general', 'zh', {...voice, pace: 'slow'});
    expect(update).toContain('包括启动时的偏好');
    expect(update).toContain('稍慢');
    expect(() => buildVoiceUpdateInstructions('general', 'zh', voice)).not.toThrow();
    const english = buildVoiceUpdateInstructions('general', 'en', voice);
    expect(english).toContain('including startup preferences');
    expect(english).toContain('Custom instruction: none');
    const practicalEnglish = {...voice, tone: 'warm' as const, intonation: 'steady' as const, pace: 'slow' as const,
      instructions: 'Controlled test. Wait for a spoken request. On request read only this sentence: The blue lantern shines beside the quiet garden where small birds rest after a long journey.'};
    expect(() => buildVoiceInstructions('general', 'en', practicalEnglish)).not.toThrow();
    expect(() => buildVoiceUpdateInstructions('general', 'en', practicalEnglish)).not.toThrow();
    const cleared = buildVoiceUpdateInstructions('general', 'zh', {...voice, instructions: ''});
    expect(cleared).toContain('清除此前自定义要求');
    expect(() => buildVoiceUpdateInstructions('general', 'zh', {...voice, instructions: 'x'.repeat(500)})).toThrow(
      expect.objectContaining({code: ErrorCode.STYLE_TOO_LONG}),
    );
  });

  test('validates runtime hot update bounds before changing local preferences', () => {
    expect(() => validateVoicePreferences({...voice, minutes: 1441})).toThrow(
      expect.objectContaining({code: ErrorCode.CONFIG_INVALID}),
    );
    expect(() => validateBackendPreferences({
      enabled: true,
      effort: 'max',
      maxOutputTokens: 32769,
      webSearch: true,
      timeoutSeconds: 60,
      instructions: '',
    })).toThrow(expect.objectContaining({code: ErrorCode.CONFIG_INVALID}));
  });

  test.each(['zh', 'en'] as const)('legacy practice produces the same general instructions in %s', locale => {
    const customVoice = {...voice, instructions: 'Synthetic custom style.'};
    const prompt = buildVoiceInstructions('practice', locale, customVoice);
    expect(prompt).toBe(buildVoiceInstructions('general', locale, customVoice));
    expect(prompt).toContain(customVoice.instructions);
    const backend: BackendPreferences = {enabled: true, effort: 'max', maxOutputTokens: 32768, webSearch: false, timeoutSeconds: 60, instructions: 'Synthetic backend style.'};
    expect(buildBackendInstructions(locale, 'practice', backend)).toBe(buildBackendInstructions(locale, 'general', backend));
    expect(buildBackendInstructions(locale, 'practice', backend)).toContain(backend.instructions);
  });
});
