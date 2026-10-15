import { afterEach, expect, it, vi } from 'vitest';
import { uploadVrAsset } from './vrShare';
import { uploadWithProgress } from '@/progress';
vi.mock('@/progress', () => ({ uploadWithProgress: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('uploads the reported 112.5 MB model in bounded chunks and commits ordered receipts', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.includes('multipart=start') ? { uploadId: 'receipt' } : { ok: true }));
  }));
  vi.mocked(uploadWithProgress).mockImplementation(async (_url, body, _init, progress) => {
    expect((body as Blob).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    progress(1, (body as Blob).size, (body as Blob).size);
    return { status: 200, text: JSON.stringify({ etag: 'part' }), headers: () => null };
  });
  const blob = new Blob([new Uint8Array(112.5 * 1024 * 1024)]);
  const progress = vi.fn();
  await uploadVrAsset({ url: 'https://example.test', token: 'test' }, '/asset', blob, progress);
  expect(uploadWithProgress).toHaveBeenCalledTimes(15);
  const parts = JSON.parse(calls[1]!.init.body as string).parts;
  expect(parts.map((p: { partNumber: number }) => p.partNumber)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  expect(progress).toHaveBeenLastCalledWith(1, blob.size, blob.size);
});

it('aborts a rejected upload without committing and does not retry authentication errors', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ uploadId: 'receipt' })));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(uploadWithProgress).mockResolvedValue({ status: 401, text: 'Sign in', headers: () => null });
  await expect(uploadVrAsset({ url: 'https://example.test', token: 'test' }, '/asset', new Blob(['data']))).rejects.toThrow('401');
  expect(uploadWithProgress).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.length).toBe(2);
  expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining('uploadId=receipt'), expect.objectContaining({ method: 'DELETE' }));
});
