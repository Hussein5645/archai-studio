import { checkInvariants, DocumentSchema, SCHEMA_VERSION, type ArchaiDocument } from '@/document';
import { applyMigrations, readSchemaVersion } from './migrations';
import { wrapLegacyViewRigs } from '@/layers/viewRig';

export type ParseResult =
  | { ok: true; document: ArchaiDocument; migratedFrom: number | null }
  | { ok: false; error: ParseError };

export interface ParseError {
  code: 'invalid-json' | 'not-a-document' | 'unsupported-version' | 'invalid-shape' | 'invariants';
  message: string;
  details?: string[];
}

/** The 3D snapshot a saved .AIR file carries for the plugins of other apps (docs/plugins.md). */
export interface SceneSnapshot {
  format: 'glb';
  version: 1;
  units: 'm';
  up: 'y';
  /** Binary glTF, base64. */
  data: string;
}

export function serializeDocument(doc: ArchaiDocument, scene3d?: SceneSnapshot): string {
  return JSON.stringify(scene3d ? { ...doc, scene3d } : doc, null, 2);
}

/** Parses, migrates and validates document JSON. Never throws. */
export function parseDocument(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: { code: 'invalid-json', message: (error as Error).message } };
  }
  return parseDocumentData(raw);
}

/** Migrates and validates already-parsed document data (see parseDocument). Never throws. */
export function parseDocumentData(raw: unknown): ParseResult {
  // The 3D snapshot is for other apps; ArchAI rebuilds the scene from the elements.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'scene3d' in raw) {
    const { scene3d: _snapshot, ...rest } = raw as Record<string, unknown>;
    raw = rest;
  }
  const version = readSchemaVersion(raw);
  if (version === null) {
    return { ok: false, error: { code: 'not-a-document', message: 'The file has no schemaVersion; it is not an ArchAI document.' } };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: 'unsupported-version',
        message: `This document uses schema version ${version}; this build supports up to ${SCHEMA_VERSION}.`,
      },
    };
  }
  let migrated: unknown = raw;
  if (version < SCHEMA_VERSION) {
    try {
      migrated = applyMigrations(raw as Record<string, unknown>, version, SCHEMA_VERSION);
    } catch (error) {
      return { ok: false, error: { code: 'unsupported-version', message: (error as Error).message } };
    }
  }
  const parsed = DocumentSchema.safeParse(migrated);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid-shape',
        message: 'The document does not match the expected structure.',
        details: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }
  const violations = checkInvariants(parsed.data);
  if (violations.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invariants',
        message: 'The document references elements, definitions or images that do not exist.',
        details: violations.slice(0, 20).map((v) => v.message),
      },
    };
  }
  // Cameras and sections saved before rigs are converted on open (their world positions are unchanged).
  return { ok: true, document: wrapLegacyViewRigs(parsed.data), migratedFrom: version < SCHEMA_VERSION ? version : null };
}
