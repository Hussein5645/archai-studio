/**
 * The example project shipped with the app (public/examples/meridian-tower.AIR), seeded into
 * Recent Projects on first boot so every install has a populated, well-built reference project.
 */
import type { ArchaiDocument } from '@/document';
import { parseDocument } from './serialize';

export const EXAMPLE_PROJECT_ID = 'doc_example_meridian_tower';

/**
 * Electron loads dist/index.html via file:// and routes with a hash fragment — the path itself
 * never changes (see app/router.ts's isFileProtocol) — so a path relative to index.html always
 * resolves. The web build serves public/ from the origin root regardless of the current SPA
 * route (real pushState navigation moves the path), so a root-absolute path is what resolves
 * there instead.
 */
function exampleProjectUrl(): string {
  const relative = 'examples/meridian-tower.AIR';
  return typeof window !== 'undefined' && window.location.protocol === 'file:' ? relative : `/${relative}`;
}

export async function fetchExampleProject(): Promise<{ text: string; document: ArchaiDocument }> {
  const response = await fetch(exampleProjectUrl());
  if (!response.ok) throw new Error(`Could not load the built-in example project (HTTP ${response.status})`);
  const text = await response.text();
  const parsed = parseDocument(text);
  if (!parsed.ok) throw new Error(`Built-in example project is invalid: ${parsed.error.message}`);
  return { text, document: parsed.document };
}
