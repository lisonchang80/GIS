import { saveProject, type ProjectPayload } from './persistence';

// Serialises project saves and tracks each project's revision (ETag).
//
// Every save sends If-Match with the revision of the last successful save (or of
// the load), so a stale tab gets 409 instead of overwriting newer content. Saves
// are queued one after another: if a second save started while the first was
// still in flight, it would carry the pre-first revision and hit 409 against
// this tab's own write.
export class ProjectSaver {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly revisions = new Map<number, string | null>();

  setRevision(id: number, revision: string | null): void {
    this.revisions.set(id, revision);
  }

  getRevision(id: number): string | null {
    return this.revisions.get(id) ?? null;
  }

  // Resolves with the new revision; rejects with the save error (an ApiError
  // that isConflict() recognises on 409). A failure does not block later saves.
  save(id: number, payload: ProjectPayload, opts: { keepalive?: boolean } = {}): Promise<string | null> {
    const run = async () => {
      const revision = await saveProject(id, payload, this.getRevision(id), opts);
      this.revisions.set(id, revision);
      return revision;
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
