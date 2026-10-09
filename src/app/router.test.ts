import { describe, expect, it } from 'vitest';
import {
  formatBoardId,
  findMatchingDocumentId,
  parseRoute,
  slugifyProjectName,
} from './router';

describe('slugifyProjectName', () => {
  it('converts simple English names to lower kebab-case', () => {
    expect(slugifyProjectName('Hussein')).toBe('hussein');
    expect(slugifyProjectName('My Arch Project 2026')).toBe('my-arch-project-2026');
  });

  it('preserves unicode characters for international project names', () => {
    expect(slugifyProjectName('مشروع حسين')).toBe('مشروع-حسين');
    expect(slugifyProjectName('Café Design')).toBe('café-design');
  });

  it('handles empty and special-character-only strings', () => {
    expect(slugifyProjectName('')).toBe('untitled');
    expect(slugifyProjectName('   ---   ')).toBe('untitled');
    expect(slugifyProjectName('!@#$%^&*()')).toBe('untitled');
  });
});

describe('formatBoardId', () => {
  it('combines slug and doc id into a board id', () => {
    expect(formatBoardId('Hussein', 'doc_abc123')).toBe('hussein-doc_abc123');
    expect(formatBoardId('My Villa', 'doc_999xyz')).toBe('my-villa-doc_999xyz');
  });

  it('updates board id when project name is updated', () => {
    const docId = 'doc_abc123';
    const initial = formatBoardId('Hussein', docId);
    expect(initial).toBe('hussein-doc_abc123');

    const updated = formatBoardId('Hussein Office Tower', docId);
    expect(updated).toBe('hussein-office-tower-doc_abc123');
  });
});

describe('parseRoute', () => {
  it('identifies home route', () => {
    expect(parseRoute('/')).toMatchObject({ isHome: true, isBoard: false, isModeling: false });
    expect(parseRoute('')).toMatchObject({ isHome: true, isBoard: false, isModeling: false });
    expect(parseRoute('/index.html')).toMatchObject({ isHome: true, isBoard: false, isModeling: false });
  });

  it('identifies modeling route', () => {
    expect(parseRoute('/modeling')).toMatchObject({ isHome: false, isBoard: false, isModeling: true });
    expect(parseRoute('/modeling/')).toMatchObject({ isHome: false, isBoard: false, isModeling: true });
    // The packaged desktop app routes through the hash, query included.
    expect(parseRoute('/modeling?asset=a1&name=Chair')).toMatchObject({ isHome: false, isBoard: false, isModeling: true });
  });

  it('identifies board routes with project name and doc id', () => {
    const parsed = parseRoute('/hussein-doc_a1b2c3d4');
    expect(parsed).toMatchObject({
      isHome: false,
      isBoard: true,
      boardId: 'hussein-doc_a1b2c3d4',
      extractedDocId: 'doc_a1b2c3d4',
      slug: 'hussein',
    });
  });

  it('identifies board routes with only project slug', () => {
    const parsed = parseRoute('/hussein');
    expect(parsed).toMatchObject({
      isHome: false,
      isBoard: true,
      boardId: 'hussein',
      extractedDocId: null,
      slug: 'hussein',
    });
  });

  it('identifies board routes with standalone doc id', () => {
    const parsed = parseRoute('/doc_a1b2c3d4');
    expect(parsed).toMatchObject({
      isHome: false,
      isBoard: true,
      boardId: 'doc_a1b2c3d4',
      extractedDocId: 'doc_a1b2c3d4',
    });
  });
});

describe('findMatchingDocumentId', () => {
  const recent = [
    { id: 'doc_111', name: 'Hussein Project', updatedAt: '2026-01-01', filePath: null },
    { id: 'doc_222', name: 'Villa', updatedAt: '2026-01-02', filePath: null },
  ];

  it('matches by extractedDocId', () => {
    const parsed = parseRoute('/hussein-project-doc_111');
    expect(findMatchingDocumentId(recent, parsed)).toBe('doc_111');
  });

  it('matches by doc id directly', () => {
    const parsed = parseRoute('/doc_222');
    expect(findMatchingDocumentId(recent, parsed)).toBe('doc_222');
  });

  it('matches by slugified name when doc id is not in url', () => {
    const parsed = parseRoute('/villa');
    expect(findMatchingDocumentId(recent, parsed)).toBe('doc_222');

    const parsed2 = parseRoute('/hussein-project');
    expect(findMatchingDocumentId(recent, parsed2)).toBe('doc_111');
  });

  it('returns null if not found', () => {
    const parsed = parseRoute('/unknown-project');
    expect(findMatchingDocumentId(recent, parsed)).toBeNull();
  });
});
