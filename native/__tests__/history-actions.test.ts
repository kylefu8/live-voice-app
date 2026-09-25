import {deleteHistoryContent} from '../src/history-actions';

const dependencies = () => ({
  audioExists: jest.fn(async () => true),
  deleteAudio: jest.fn(async (_id: string) => undefined),
  deleteText: jest.fn(async (_id: string) => undefined),
  cancelNaming: jest.fn(),
});

test('audio-only deletion preserves text and title generation', async () => {
  const deps = dependencies();
  await deleteHistoryContent('synthetic', 'audio', deps);
  expect(deps.deleteAudio).toHaveBeenCalledWith('synthetic');
  expect(deps.deleteText).not.toHaveBeenCalled();
  expect(deps.cancelNaming).not.toHaveBeenCalled();
});

test('complete deletion cancels late naming and removes audio before text', async () => {
  const deps = dependencies();
  await deleteHistoryContent('synthetic', 'conversation', deps);
  expect(deps.cancelNaming).toHaveBeenCalledWith('synthetic');
  expect(deps.deleteText).toHaveBeenCalledWith('synthetic');
  expect(deps.deleteAudio.mock.invocationCallOrder[0]).toBeLessThan(deps.deleteText.mock.invocationCallOrder[0]);
});

test('failed audio removal leaves the text record accessible', async () => {
  const deps = dependencies();
  deps.deleteAudio.mockRejectedValue(new Error('recording_failed'));
  await expect(deleteHistoryContent('synthetic', 'conversation', deps)).rejects.toThrow('recording_failed');
  expect(deps.deleteText).not.toHaveBeenCalled();
});

test('missing audio permits text-only deletion but a failed lookup does not', async () => {
  const deps = dependencies();
  deps.audioExists.mockResolvedValue(false);
  await deleteHistoryContent('text-only', 'conversation', deps);
  expect(deps.deleteAudio).not.toHaveBeenCalled();
  expect(deps.deleteText).toHaveBeenCalledTimes(1);
  deps.audioExists.mockRejectedValue(new Error('recording_failed'));
  await expect(deleteHistoryContent('unreadable', 'conversation', deps)).rejects.toThrow('recording_failed');
  expect(deps.deleteText).toHaveBeenCalledTimes(1);
});
