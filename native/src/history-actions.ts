type HistoryDeletionDependencies = {
  audioExists(id: string): Promise<boolean>;
  deleteAudio(id: string): Promise<void>;
  deleteText(id: string): Promise<void>;
  cancelNaming(id: string): void;
};

/** Remove audio first so a recording failure cannot hide retained audio. */
export async function deleteHistoryContent(
  id: string,
  scope: 'audio' | 'conversation',
  dependencies: HistoryDeletionDependencies,
): Promise<void> {
  if (scope === 'conversation') dependencies.cancelNaming(id);
  if (await dependencies.audioExists(id)) await dependencies.deleteAudio(id);
  if (scope === 'conversation') await dependencies.deleteText(id);
}
