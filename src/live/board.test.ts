import { describe, expect, it } from 'vitest';
import { nameFromKey } from './board';

describe('Live Bridge project names', () => {
  it('names a project after the linked model', () => {
    expect(nameFromKey(String.raw`rhino:C:\Projects\House A.3dm`)).toBe('House A');
    expect(nameFromKey('revit:D:/jobs/Tower.rvt')).toBe('Tower');
    expect(nameFromKey('blender:unsaved')).toBe('unsaved');
    expect(nameFromKey('3dsmax:unsaved:3ds Max scene')).toBe('3ds Max scene');
    expect(nameFromKey('autocad:')).toBe('Live model');
  });
});
