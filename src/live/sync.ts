/**
 * Live link / Live Bridge helpers for what a plugin pulls (docs/plugins.md, "Live link";
 * docs/live-bridge-proposal.md). The sync itself is the Live Bridge's `bridge-sync` (and the
 * live link's `sync-live-link`, src/bridge/commands.ts).
 */
import type { ArchaiDocument, Element } from '@/document';

export interface LiveLinkTag {
  key: string;
  app: string;
}

/** The old live link's tag on an element (projects synced before the Live Bridge). */
export function liveLinkOf(element: Element | undefined | null): LiveLinkTag | null {
  const value = element?.meta?.['liveLink'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = value['key'];
  const app = value['app'];
  return typeof key === 'string' ? { key, app: typeof app === 'string' ? app : '' } : null;
}

/**
 * The document as the app linked by `key` receives it: without what that app sent itself (no
 * loops), without elements that are not shared (source-only, archai-only), and empty when its
 * link is paused or set to receive nothing.
 */
export function withoutLink(doc: ArchaiDocument, key: string): ArchaiDocument {
  const bridge = doc.bridge;
  const source = bridge?.sources[key];
  if (source && (source.mode === 'paused' || source.receives === 'nothing')) return { ...doc, elements: {} };
  const excluded = new Set<string>();
  for (const element of Object.values(doc.elements)) {
    const binding = bridge?.elements[element.id];
    if (liveLinkOf(element)?.key === key || binding?.refs[key] || (binding?.share ?? 'shared') !== 'shared') excluded.add(element.id);
  }
  if (excluded.size === 0) return doc;
  const out = (element: Element): boolean => {
    for (let current: Element | undefined = element; current; current = current.parentId ? doc.elements[current.parentId] : undefined) if (excluded.has(current.id)) return true;
    return false;
  };
  return { ...doc, elements: Object.fromEntries(Object.entries(doc.elements).filter(([, element]) => !out(element))) };
}
