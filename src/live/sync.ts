/**
 * Live link (docs/plugins.md): a modelling app's ArchAI plugin keeps its model in sync with the
 * project. Each sync replaces everything that plugin sent before (elements tagged
 * `meta.liveLink = { key, app }`) with its current model, built through the same import as
 * *Send to ArchAI* (src/revit/importRevit.ts), as one undo step. Materials are reused by name and
 * colour across syncs, so assignments made in ArchAI to other elements keep working.
 */
import { z } from 'zod';
import type { ArchaiDocument, Element, JsonValue } from '@/document';
import { defineMutation, CommandError } from '@/commands/contract';
import { removeSubtree, snapshot } from '@/commands/helpers';
import { RevitExchangeSchema } from '@/revit/exchange';
import { importRevitModel, type RevitImportReport } from '@/revit/importRevit';

export interface LiveLinkTag {
  key: string;
  app: string;
}

export function liveLinkOf(element: Element | undefined | null): LiveLinkTag | null {
  const value = element?.meta?.['liveLink'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = value['key'];
  const app = value['app'];
  return typeof key === 'string' ? { key, app: typeof app === 'string' ? app : '' } : null;
}

/** The document without what one link sent (what that plugin pulls back). */
export function withoutLink(doc: ArchaiDocument, key: string): ArchaiDocument {
  const linked = new Set(Object.values(doc.elements).filter((element) => liveLinkOf(element)?.key === key).map((element) => element.id));
  if (linked.size === 0) return doc;
  const inLink = (element: Element): boolean => {
    for (let current: Element | undefined = element; current; current = current.parentId ? doc.elements[current.parentId] : undefined) if (linked.has(current.id)) return true;
    return false;
  };
  return { ...doc, elements: Object.fromEntries(Object.entries(doc.elements).filter(([, element]) => !inLink(element))) };
}

const materialSource = (key: string, material: { name: string; color: string }) => `live:${key}:${material.name}:${material.color}`.slice(0, 200);

export const syncLiveLink = defineMutation({
  id: 'sync-live-link',
  label: 'Live link sync',
  description: "Replaces the model a plugin's live link sent before (elements tagged with its key) with `model`, an exchange file (archaiRevit: 1). Returns the import report.",
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ key: z.string().min(1).max(300), app: z.string().max(60).default(''), model: z.unknown() }),
  run: (ctx, input): RevitImportReport & { removed: number } => {
    const parsed = RevitExchangeSchema.safeParse(input.model);
    if (!parsed.success) throw new CommandError('invalid-input', 'Not a valid ArchAI exchange model', parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`));
    const selection = ctx.ui.selection;
    let removed = 0;
    for (const element of Object.values(ctx.doc.elements)) {
      if (ctx.doc.elements[element.id] && liveLinkOf(element)?.key === input.key) removed += removeSubtree(ctx.doc, element.id).length;
    }
    const before = new Set(Object.keys(ctx.doc.elements));
    const existing = new Map(Object.values(ctx.doc.materials).flatMap((material) => (material.source ? [[material.source, material.id] as const] : [])));
    const report = importRevitModel(ctx, parsed.data, {
      reuseMaterial: (material) => existing.get(materialSource(input.key, material)),
      materialSource: (material) => materialSource(input.key, material),
    });
    const tag = { key: input.key, app: input.app || parsed.data.app || '' } as unknown as JsonValue;
    for (const element of Object.values(ctx.doc.elements)) {
      if (before.has(element.id)) continue;
      element.meta = { ...snapshot(element.meta ?? {}), liveLink: tag };
    }
    // The user's selection survives a sync (minus what was replaced).
    ctx.ui.selection = selection.filter((id) => ctx.doc.elements[id]);
    return { ...report, removed };
  },
});

export const liveCommands = [syncLiveLink];
