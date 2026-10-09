/**
 * Entering the profile drawing mode when a floor, ceiling or level tool is chosen (see
 * ./builtin/profileEdit.ts for the mode's commands). Kept free of command imports so every tool
 * command can use it.
 */
import type { ProfileKind, ToolId } from '@/store';
import type { MutationContext } from './contract';

/** The profile kind a tool draws, or null. */
export function profileKindOfTool(tool: ToolId | string): ProfileKind | null {
  if (tool === 'arch:floor') return 'floor';
  if (tool === 'arch:ceiling') return 'ceiling';
  if (tool === 'arch:level') return 'level';
  return null;
}

/** Starts a new profile of the tool's kind unless one is being drawn already. */
export function enterProfileModeForTool(ctx: MutationContext, tool: ToolId | string): void {
  const kind = profileKindOfTool(tool);
  if (!kind || ctx.ui.profileEdit) return;
  ctx.ui.profileEdit = { kind, targetId: null, startIds: Object.keys(ctx.doc.elements) };
}

/** How the curves of a boundary being drawn look (Revit draws its sketch lines magenta). */
export const PROFILE_SKETCH_STYLE = { fill: null, stroke: '#d946ef', strokeWidth: 20, opacity: 1 };
