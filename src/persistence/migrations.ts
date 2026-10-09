/**
 * Schema migrations run before validation, oldest first. Each step upgrades a raw JSON value
 * from `from` to `from + 1`. Today there is only v1, so the list is empty — the runner exists
 * so that the format can evolve without a rewrite.
 */
export interface Migration {
  from: number;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

export const MIGRATIONS: readonly Migration[] = [];

export function readSchemaVersion(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const version = (raw as Record<string, unknown>)['schemaVersion'];
  return typeof version === 'number' && Number.isInteger(version) ? version : null;
}

export function applyMigrations(
  raw: Record<string, unknown>,
  from: number,
  to: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Record<string, unknown> {
  let current = raw;
  for (let version = from; version < to; version++) {
    const step = migrations.find((m) => m.from === version);
    if (!step) throw new Error(`No migration from schema version ${version}`);
    current = { ...step.migrate(current), schemaVersion: version + 1 };
  }
  return current;
}
