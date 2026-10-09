import { z } from 'zod';
import { randomIds, type IdSource } from '@/document/ids';
import {
  WorkspaceSchema,
  DefinitionSchema,
  BlobSchema,
  MaterialLibrarySchema,
  type ArchaiDocument,
} from '@/document';
import type { Platform } from '@/platform/types';
import { createEmptyDocument } from '@/document/create';

export const TEMPLATE_FILE_VERSION = 1 as const;
export const LOCAL_TEMPLATES_KEY = 'archai_local_templates';

export const ArchaiTemplateSchema = z.strictObject({
  archaiTemplate: z.literal(TEMPLATE_FILE_VERSION),
  id: z.string(),
  name: z.string().max(200),
  description: z.string().max(1000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  workspace: WorkspaceSchema,
  definitions: z.record(z.string(), DefinitionSchema),
  blobs: z.record(z.string(), BlobSchema),
  materials: MaterialLibrarySchema.default({}),
});

export type ArchaiTemplate = z.infer<typeof ArchaiTemplateSchema>;

export function createTemplateFromDocument(
  doc: ArchaiDocument,
  name: string,
  description?: string,
  ids: IdSource = randomIds,
  now: () => string = () => new Date().toISOString(),
): ArchaiTemplate {
  const timestamp = now();
  return {
    archaiTemplate: TEMPLATE_FILE_VERSION,
    id: ids.next('tmpl'),
    name: name.trim() || doc.meta.name || 'Untitled Template',
    description: description?.trim() || undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspace: JSON.parse(JSON.stringify(doc.workspace)),
    definitions: JSON.parse(JSON.stringify(doc.definitions)),
    blobs: JSON.parse(JSON.stringify(doc.blobs)),
    materials: JSON.parse(JSON.stringify(doc.materials)),
  };
}

export function createDocumentFromTemplate(
  template: ArchaiTemplate | null,
  name: string,
  ids: IdSource,
  now: () => string,
): ArchaiDocument {
  const empty = createEmptyDocument({ ids, now, name });
  if (!template) return empty;

  return {
    ...empty,
    workspace: JSON.parse(JSON.stringify(template.workspace)),
    definitions: JSON.parse(JSON.stringify(template.definitions)),
    blobs: JSON.parse(JSON.stringify(template.blobs)),
    materials: JSON.parse(JSON.stringify(template.materials)),
    elements: {},
  };
}

export function serializeTemplate(template: ArchaiTemplate): string {
  return JSON.stringify(template, null, 2);
}

export function parseTemplateFile(text: string): { ok: true; template: ArchaiTemplate } | { ok: false; error: string } {
  try {
    const raw = JSON.parse(text);
    const parsed = ArchaiTemplateSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid template file structure' };
    }
    return { ok: true, template: parsed.data as ArchaiTemplate };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON format' };
  }
}

export async function getLocalTemplates(platform: Platform): Promise<ArchaiTemplate[]> {
  try {
    const raw = await platform.storage.get(LOCAL_TEMPLATES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => ArchaiTemplateSchema.safeParse(item).success);
  } catch {
    return [];
  }
}

export async function saveLocalTemplate(platform: Platform, template: ArchaiTemplate): Promise<void> {
  const existing = await getLocalTemplates(platform);
  const index = existing.findIndex((t) => t.id === template.id);
  let next: ArchaiTemplate[];
  if (index >= 0) {
    next = [...existing];
    next[index] = template;
  } else {
    next = [template, ...existing];
  }
  await platform.storage.set(LOCAL_TEMPLATES_KEY, JSON.stringify(next));
}

export async function deleteLocalTemplate(platform: Platform, id: string): Promise<void> {
  const existing = await getLocalTemplates(platform);
  const next = existing.filter((t) => t.id !== id);
  await platform.storage.set(LOCAL_TEMPLATES_KEY, JSON.stringify(next));
}

export function downloadTemplateFile(template: ArchaiTemplate, fileName?: string): void {
  if (typeof document === 'undefined') return;
  const content = serializeTemplate(template);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName || `${template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ait`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
