import {
  extractOutputText,
  generateHistoryTitle,
  probeBackend,
  runBackendDelegation,
} from '../src/backend';
import {ErrorCode, ProtocolError} from '../src/protocol';
import type {BackendPreferences, Credential, TranscriptFragment} from '../src/types';

const credential: Credential = {
  endpoint: 'https://backend.example/v1',
  model: 'synthetic-backend',
  auth: 'bearer',
  apiKey: 'synthetic-key',
};

const preferences: BackendPreferences = {
  enabled: true,
  effort: 'max',
  maxOutputTokens: 128,
  webSearch: false,
  timeoutSeconds: 5,
  instructions: 'Keep the answer concise.',
};

const history: TranscriptFragment[] = [
  {role: 'user', text: 'What time is it?', startMs: 0, endMs: 500},
];

function response(value: unknown, ok = true, status = 200): Response {
  return {ok, status, json: async () => value} as Response;
}

describe('backend adapter', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    Object.defineProperty(globalThis, 'fetch', {configurable: true, value: fetchMock});
  });

  test('generates a bounded title without search or conversation custom instructions', async () => {
    fetchMock.mockResolvedValue(response({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: 'Time zones'}]}]}));
    expect(await generateHistoryTitle(credential, history, 'en')).toBe('Time zones');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({store: false, model: credential.model, max_output_tokens: 1024});
    expect(body.tools).toBeUndefined();
    expect(body.instructions).not.toContain(preferences.instructions);
    fetchMock.mockRejectedValue(new Error('synthetic provider failure'));
    expect(await generateHistoryTitle(credential, history, 'en')).toBeNull();
  });

  test('cancelled title calls cannot publish a late success', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return response({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: 'Late title'}]}]});
    });
    expect(await generateHistoryTitle(credential, history, 'en', controller.signal)).toBeNull();
  });

  test('probe uses a minimal Responses request without web search', async () => {
    fetchMock.mockResolvedValue(response({output: [{content: [{type: 'output_text', text: 'OK'}]}]}));
    await probeBackend(credential, preferences);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchMock.mock.calls[0][0]).toBe('https://backend.example/v1/responses');
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.max_output_tokens).toBe(16);
  });

  test('extracts only output_text and reports verified source annotations', async () => {
    fetchMock.mockResolvedValue(
      response({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'A grounded answer.',
                annotations: [{type: 'url_citation', title: 'Source', url: 'https://source.example/a'}],
              },
            ],
          },
        ],
        usage: {input_tokens: 3, output_tokens: 4},
      }),
    );
    const sources: {title: string; url: string}[] = [];
    const result = await runBackendDelegation({
      credential,
      preferences,
      history,
      mode: 'general',
      locale: 'en',
      onSources: (items) => sources.push(...items),
    });
    expect(result.text).toBe('A grounded answer.');
    expect(sources).toEqual([{title: 'Source', url: 'https://source.example/a'}]);
    expect(extractOutputText({output: [{content: [{type: 'reasoning', text: 'hidden'}]}]})).toBe('');
  });

  test('web search failure and unsupported output remain visible', async () => {
    fetchMock.mockResolvedValue(
      response({output: [{type: 'web_search_call', status: 'failed'}, {type: 'message', content: [{type: 'output_text', text: 'guess'}]}]}),
    );
    await expect(
      runBackendDelegation({credential, preferences: {...preferences, webSearch: true}, history, mode: 'general'}),
    ).rejects.toMatchObject({code: ErrorCode.BACKEND_WEB_SEARCH_FAILED});

    fetchMock.mockResolvedValue(response({output: [{type: 'function_call', name: 'unknown', arguments: '{}'}]}));
    await expect(runBackendDelegation({credential, preferences, history, mode: 'general'})).rejects.toMatchObject({
      code: ErrorCode.BACKEND_UNSUPPORTED_OUTPUT,
    });
  });

  test('does not expose provider body or key on HTTP failure', async () => {
    fetchMock.mockResolvedValue(response({error: {message: 'synthetic-key should not leak'}}, false, 401));
    try {
      await probeBackend(credential, preferences);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(ErrorCode.BACKEND_HTTP_401);
      expect(String(error)).not.toContain('synthetic-key');
    }
  });
});
