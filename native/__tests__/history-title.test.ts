import {buildTitleRequest, normalizeHistoryTitle, parseGeneratedTitle, TITLE_EXCERPT_MAX_LENGTH} from '../src/history-title';

const completed = (text: string) => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text}]}]});

test('bounds an excerpt around the opening and closing while keeping request independent', () => {
  const request = buildTitleRequest('synthetic-model', [
    {role: 'user', text: 'Opening topic ' + '😀'.repeat(8000), startMs: 0, endMs: 1},
    {role: 'assistant', text: 'Ending topic', startMs: 1, endMs: 2},
  ], 'zh')!;
  const input = request.input as {content: string}[];
  expect(Array.from(input[0].content).length).toBeLessThanOrEqual(TITLE_EXCERPT_MAX_LENGTH + 22);
  expect(input[0].content).toContain('Opening topic');
  expect(input[0].content).toContain('Ending topic');
  expect(request).toMatchObject({model: 'synthetic-model', store: false, max_output_tokens: 1024});
  expect(request).not.toHaveProperty('tools');
  expect(request).not.toHaveProperty('reasoning');
});

test('skips empty conversations and validates Unicode titles', () => {
  expect(buildTitleRequest('synthetic', [], 'en')).toBeNull();
  expect(normalizeHistoryTitle('  Weekend   plans  ')).toBe('Weekend plans');
  expect(normalizeHistoryTitle('😀'.repeat(60))).toHaveLength(120);
  expect(normalizeHistoryTitle('😀'.repeat(61))).toBeNull();
  expect(normalizeHistoryTitle(' ')).toBeNull();
  expect(normalizeHistoryTitle('bad\u0000name')).toBeNull();
});

test('accepts completed short titles and rejects partial, tool, refusal and multiline output', () => {
  expect(parseGeneratedTitle(completed('“周末出游计划”'))).toBe('周末出游计划');
  expect(parseGeneratedTitle({...completed('partial'), status: 'incomplete'})).toBeNull();
  expect(parseGeneratedTitle(completed('one\ntwo'))).toBeNull();
  expect(parseGeneratedTitle(completed('x'.repeat(61)))).toBeNull();
  expect(parseGeneratedTitle({status: 'completed', output: [{type: 'function_call'}]})).toBeNull();
  expect(parseGeneratedTitle({status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'No'}]}]})).toBeNull();
});
