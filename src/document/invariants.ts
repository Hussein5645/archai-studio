/**
 * Referential invariants that the zod schema cannot express: parents exist, no parent cycles,
 * instances point at definitions, images point at blobs, definitions never contain
 * themselves. Run on import and, in development, after every command.
 */
import type { ArchaiDocument, Element, ElementTable } from './types';

export interface InvariantViolation {
  code:
    | 'missing-parent'
    | 'parent-cycle'
    | 'missing-definition'
    | 'missing-blob'
    | 'definition-cycle'
    | 'id-mismatch';
  message: string;
  elementId?: string;
  definitionId?: string;
}

function checkTable(
  elements: ElementTable,
  scope: string,
  doc: ArchaiDocument,
  out: InvariantViolation[],
): void {
  for (const [key, element] of Object.entries(elements)) {
    if (element.id !== key) {
      out.push({ code: 'id-mismatch', elementId: key, message: `${scope}: key ${key} holds element ${element.id}` });
    }
    if (element.parentId !== null) {
      const parent = elements[element.parentId];
      if (!parent) {
        out.push({ code: 'missing-parent', elementId: element.id, message: `${scope}: ${element.id} has missing parent ${element.parentId}` });
      }
    }
    if (element.kind === 'instance' && !doc.definitions[element.definitionId]) {
      out.push({ code: 'missing-definition', elementId: element.id, message: `${scope}: ${element.id} references missing definition ${element.definitionId}` });
    }
    if (element.kind === 'image' && !doc.blobs[element.blobId]) {
      out.push({ code: 'missing-blob', elementId: element.id, message: `${scope}: ${element.id} references missing blob ${element.blobId}` });
    }
  }
  // Parent cycles: walk up from every element with a visited set.
  for (const element of Object.values(elements)) {
    const seen = new Set<string>();
    let current: Element | undefined = element;
    while (current && current.parentId !== null) {
      if (seen.has(current.id)) {
        out.push({ code: 'parent-cycle', elementId: element.id, message: `${scope}: parent cycle through ${element.id}` });
        break;
      }
      seen.add(current.id);
      current = elements[current.parentId];
    }
  }
}

/** Definitions referenced (transitively) by a template definition. */
function definitionDependencies(doc: ArchaiDocument, definitionId: string): Set<string> {
  const deps = new Set<string>();
  const definition = doc.definitions[definitionId];
  if (!definition || definition.kind !== 'template') return deps;
  for (const element of Object.values(definition.elements)) {
    if (element.kind === 'instance') deps.add(element.definitionId);
  }
  return deps;
}

export function checkInvariants(doc: ArchaiDocument): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  checkTable(doc.elements, 'document', doc, out);

  for (const [key, definition] of Object.entries(doc.definitions)) {
    if (definition.id !== key) {
      out.push({ code: 'id-mismatch', definitionId: key, message: `definitions: key ${key} holds ${definition.id}` });
    }
    if (definition.kind === 'template') {
      checkTable(definition.elements, `definition ${definition.id}`, doc, out);
    } else if (!doc.blobs[definition.blobId]) {
      out.push({ code: 'missing-blob', definitionId: definition.id, message: `definition ${definition.id} references missing blob ${definition.blobId}` });
    }
  }

  // Definition cycles (a template that transitively instantiates itself).
  for (const definitionId of Object.keys(doc.definitions)) {
    const stack = [...definitionDependencies(doc, definitionId)];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const dep = stack.pop()!;
      if (dep === definitionId) {
        out.push({ code: 'definition-cycle', definitionId, message: `definition ${definitionId} contains itself` });
        break;
      }
      if (seen.has(dep)) continue;
      seen.add(dep);
      stack.push(...definitionDependencies(doc, dep));
    }
  }

  for (const [key, blob] of Object.entries(doc.blobs)) {
    if (blob.id !== key) out.push({ code: 'id-mismatch', message: `blobs: key ${key} holds ${blob.id}` });
  }
  return out;
}
