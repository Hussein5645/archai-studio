/**
 * An app's geometry stays the app's (docs/live-bridge.md): an element that came from a linked app
 * and is edited in ArchAI (moved, reshaped, renamed, deleted) is put back as the app
 * sent it, for every part the app decides. Material assignments always remain ArchAI's. Converting it into an ArchAI
 * element releases it; parts handed to ArchAI or shared in the Live Bridge panel stay editable.
 *
 * The guard watches document changes (commands, undo, redo) and runs `bridge-revert` right after
 * an edit that touched such an element.
 */
import type { CommandExecutor } from '@/commands';
import type { AppStore } from '@/store';
import type { ArchaiDocument } from '@/document';
import { BRIDGE_FACETS } from '@/document';
import { originOf, ownerOf } from './engine';
import { childLookup, facetHashes, type ChildLookup } from './facets';

/** Whether an element is an app's and differs (in parts the app decides) from what the app sent. */
export function needsRevert(doc: ArchaiDocument, id: string, children?: ChildLookup): boolean {
  const bridge = doc.bridge;
  const binding = bridge?.elements[id];
  const origin = originOf(binding);
  if (!bridge || !binding || !origin || !binding.snapshot) return false;
  const element = doc.elements[id];
  if (!element) return true;
  const hashes = facetHashes(children ?? childLookup(doc.elements), element);
  return BRIDGE_FACETS.some((facet) => ownerOf(bridge, binding, facet) === origin && hashes[facet] !== binding.state[facet]);
}

export function startBridgeGuard(executor: CommandExecutor, store: AppStore, notify?: (app: string) => void): () => void {
  const touched = new Set<string>();
  let scheduled = false;
  return executor.onDocChange((patches) => {
    for (const patch of patches) {
      if (patch.path[0] === 'elements' && typeof patch.path[1] === 'string') touched.add(patch.path[1]);
    }
    if (touched.size === 0 || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const ids = [...touched];
      touched.clear();
      const doc = store.getState().doc;
      if (!doc.bridge) return;
      const children = childLookup(doc.elements);
      const revert = ids.filter((id) => needsRevert(doc, id, children));
      if (revert.length === 0) return;
      const result = executor.dispatchSync('bridge-revert', { ids: revert });
      if (result.ok && notify) {
        const origin = originOf(doc.bridge.elements[revert[0]!]);
        notify(origin ? doc.bridge.sources[origin]?.app || 'Its app' : 'Its app');
      }
    });
  });
}
