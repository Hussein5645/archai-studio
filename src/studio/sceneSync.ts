import { DocumentSchema, type ArchaiDocument } from '@/document';

const TABLES = ['elements', 'definitions', 'materials', 'blobs'] as const;
type Table = (typeof TABLES)[number];
type Changes = Record<Table, { upsert: Record<string, unknown>; remove: string[] }>;
export type SceneFrame = {
  protocol: 1;
  stream: string;
  projectId: string;
  revision: number;
} & ({ kind: 'snapshot'; document: ArchaiDocument } | {
  kind: 'delta'; baseRevision: number; changes: Changes;
  meta: ArchaiDocument['meta']; workspace: ArchaiDocument['workspace'];
});

/** A stream is scoped to one connection; revision gaps require a fresh snapshot. */
export class SceneSender {
  private previous: ArchaiDocument | null = null;
  private revision = 0;
  private stream = '';

  next(document: ArchaiDocument, snapshot = false): SceneFrame {
    if (!this.previous || this.previous.id !== document.id || snapshot) {
      this.stream = crypto.randomUUID();
      this.revision = 0;
      this.previous = null;
    }
    const base = { protocol: 1 as const, stream: this.stream, projectId: document.id, revision: ++this.revision };
    const previous = this.previous;
    this.previous = document;
    if (!previous) return { ...base, kind: 'snapshot', document };
    const changes = Object.fromEntries(TABLES.map((table) => [table, {
      upsert: Object.fromEntries(Object.entries(document[table]).filter(([id, value]) =>
        value !== previous[table][id] && JSON.stringify(value) !== JSON.stringify(previous[table][id]))),
      remove: Object.keys(previous[table]).filter((id) => !Object.hasOwn(document[table], id)),
    }])) as Changes;
    return { ...base, kind: 'delta', baseRevision: base.revision - 1, changes, meta: document.meta, workspace: document.workspace };
  }
}

export class SceneReceiver {
  private stream = '';
  private revision = 0;
  private document: ArchaiDocument | null = null;

  accept(frame: SceneFrame): ArchaiDocument {
    if (frame.protocol !== 1 || !Number.isSafeInteger(frame.revision) || frame.revision < 1)
      throw new Error('Unsupported render scene protocol');
    let next: ArchaiDocument;
    if (frame.kind === 'snapshot') {
      if (frame.document.id !== frame.projectId) throw new Error('Render project mismatch');
      next = DocumentSchema.parse(frame.document);
    } else {
      if (!this.document || frame.stream !== this.stream || frame.projectId !== this.document.id ||
        frame.baseRevision !== this.revision || frame.revision !== this.revision + 1)
        throw new Error('Render scene revision gap; a new snapshot is required');
      const tables = Object.fromEntries(TABLES.map((table) => {
        const entries: Record<string, unknown> = { ...this.document![table], ...frame.changes[table].upsert };
        for (const id of frame.changes[table].remove) delete entries[id];
        return [table, entries];
      }));
      next = DocumentSchema.parse({ ...this.document, ...tables, meta: frame.meta, workspace: frame.workspace });
    }
    this.stream = frame.stream;
    this.revision = frame.revision;
    this.document = next;
    return next;
  }
}
