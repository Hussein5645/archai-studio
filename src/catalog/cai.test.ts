import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaiCatalog, CaiMappingSchema, CaiMetadataSchema, checkPackageContents } from './cai';

function packageBytes(metadata: Record<string, unknown>, mapping: Record<string, unknown>): Uint8Array {
  return zipSync({
    'metadata.json': strToU8(JSON.stringify(metadata)),
    'mapping.json': strToU8(JSON.stringify(mapping)),
    'views/top.png': Uint8Array.from([137, 80, 78, 71]),
    'views/front.png': Uint8Array.from([137, 80, 78, 71]),
    'views/side.png': Uint8Array.from([137, 80, 78, 71]),
    'models/model.glb': Uint8Array.from([103, 108, 84, 70]),
  });
}

const metadata = {
  caiVersion: 1,
  id: 'door-single-900',
  name: 'Single door 900',
  category: 'Architecture/Openings/Doors',
  kind: 'system',
  system: { type: 'door', parameters: { operation: 'swing' } },
  size: { width: 900, height: 120 },
  tags: ['single'],
};

const mapping = {
  version: 1,
  views: { top: 'views/top.png', front: 'views/front.png', side: 'views/side.png' },
  models: { glb: 'models/model.glb' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CaiCatalog', () => {
  it('lists inline index entries without downloading their packages', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith('/catalog.json')) {
          return new Response(
            JSON.stringify({
              version: 1,
              packages: [
                {
                  key: 'Populate/Plants/fern_02.cai',
                  metadata: { caiVersion: 1, id: 'fern_02', name: 'Fern', category: 'Populate/Plants', kind: 'asset', size: { width: 600, height: 500 }, modelHeight: 430, lod: { low: true } },
                  mapping: { version: 1, views: { top: 'views/top.png', preview: 'views/preview.png' }, models: { glb: 'models/model.glb', glbLow: 'models/model-low.glb' } },
                  top: 'Populate/Plants/fern_02.top.png',
                  preview: 'Populate/Plants/fern_02.preview.png',
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(new Blob([Uint8Array.from([137, 80, 78, 71])]), { status: 200, headers: { 'content-type': 'image/png' } });
      }),
    );
    const catalog = new CaiCatalog('https://bucket.example/');
    const root = await catalog.load();
    const fern = root.folders[0]!.folders[0]!.assets[0]!;
    expect(fern).toMatchObject({ id: 'fern_02', name: 'Fern', path: 'Populate/Plants/fern_02', size: { width: 600, height: 500 } });
    expect(fern.thumbnail?.url).toBe('https://bucket.example/Populate/Plants/fern_02.preview.png');
    expect(fern.models?.glbLow?.path).toBe('models/model-low.glb');
    expect(fern.package?.url).toBe('https://bucket.example/Populate/Plants/fern_02.cai');
    await catalog.fetchImage(fern);
    expect(fetched.some((url) => url.endsWith('.cai'))).toBe(false);
  });

  it('loads, validates and maps an R2 .CAI package', async () => {
    const archive = packageBytes(metadata, mapping);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/catalog.json')) {
          return new Response(
            JSON.stringify({
              version: 1,
              source: 'cloudflare-r2:archai-assets',
              folders: [],
              packages: [{ key: 'Architecture/Openings/Doors/door-single-900.CAI' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(new Blob([archive as BlobPart]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }),
    );

    const catalog = new CaiCatalog('https://assets.example.test/');
    const root = await catalog.load();
    const doors = root.folders[0]!.folders[0]!.folders[0]!;
    expect(catalog.source).toBe('cloudflare-r2:archai-assets');
    expect(doors.assets[0]).toMatchObject({
      id: 'door-single-900',
      kind: 'system',
      systemType: 'door',
      size: { width: 900, height: 120 },
      package: { key: 'Architecture/Openings/Doors/door-single-900.CAI', version: 1 },
      image: { path: 'views/top.png', mime: 'image/png' },
      model: { path: 'models/model.glb', format: 'glb' },
    });
    const image = await catalog.fetchImage(doors.assets[0]!);
    expect(image.mime).toBe('image/png');
    expect([...image.bytes]).toEqual([137, 80, 78, 71]);
  });

  it('requires a mapped top view and at least one 3D model for placed packages', () => {
    const regular = CaiMetadataSchema.parse({ caiVersion: 1, id: 'sofa', name: 'Sofa', category: 'Furnish/Seating', size: { width: 2000, height: 900 } });
    expect(checkPackageContents(regular, CaiMappingSchema.parse({ version: 1, views: { top: 'views/top.png' }, models: {} }))).toMatch(/GLB or FBX/);
    expect(checkPackageContents(regular, CaiMappingSchema.parse({ version: 1, views: {}, models: { glb: 'models/model.glb' } }))).toMatch(/views.top/);
    const door = CaiMetadataSchema.parse(metadata);
    expect(checkPackageContents(door, CaiMappingSchema.parse({ version: 1, views: { top: 'views/top.png' }, models: { glb: 'models/model.glb' } }))).toMatch(/front, and side/);
  });

  it('lets line-based system types ship a section swatch instead of views and models', () => {
    const wall = CaiMetadataSchema.parse({
      caiVersion: 1,
      id: 'wall-brick-cavity',
      name: 'Brick cavity wall',
      kind: 'system',
      system: { type: 'wall', parameters: { layers: [{ name: 'Brick', role: 'core', thickness: 102 }], locationLine: 'outside' } },
    });
    expect(wall.size).toEqual({ width: 0, height: 0 });
    expect(checkPackageContents(wall, CaiMappingSchema.parse({ version: 1, views: { section: 'views/section.svg' }, models: {} }))).toBeNull();
    expect(checkPackageContents(wall, CaiMappingSchema.parse({ version: 1, views: {}, models: {} }))).toMatch(/section/);
  });

  it('validates system parameters against the tool schema', () => {
    const result = CaiMetadataSchema.safeParse({
      caiVersion: 1,
      id: 'bad-column',
      name: 'Bad column',
      kind: 'system',
      system: { type: 'column', parameters: { shape: 'hexagon' } },
      size: { width: 500, height: 500 },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('shape');
  });

  it('lists system types from the system/ folder without adding them to the library tree', async () => {
    const wallArchive = zipSync({
      'metadata.json': strToU8(
        JSON.stringify({
          caiVersion: 1,
          id: 'wall-stud',
          name: 'Stud partition',
          kind: 'system',
          system: { type: 'wall', parameters: { layers: [{ name: 'Board', role: 'finish', thickness: 13 }, { name: 'Stud', role: 'core', thickness: 90 }, { name: 'Board', role: 'finish', thickness: 13 }] } },
        }),
      ),
      'mapping.json': strToU8(JSON.stringify({ version: 1, views: { section: 'views/section.png' }, models: {} })),
      'views/section.png': Uint8Array.from([137, 80, 78, 71]),
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:section');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/catalog.json')) {
          return new Response(JSON.stringify({ version: 1, folders: ['Furnish'], packages: [], system: [{ tool: 'wall', key: 'system/wall/wall-stud.cai' }] }), { status: 200 });
        }
        return new Response(new Blob([wallArchive as BlobPart]), { status: 200 });
      }),
    );
    const catalog = new CaiCatalog('https://assets.example.test/');
    const root = await catalog.load();
    expect(root.assets).toHaveLength(0);
    const walls = await catalog.loadSystemTypes('wall');
    expect(walls.map((asset) => asset.id)).toEqual(['wall-stud']);
    expect((walls[0]!.systemParameters?.['layers'] as unknown[]).length).toBe(3);
    expect(walls[0]!.views?.section?.url).toBe('blob:section');
    expect(await catalog.loadSystemTypes('door')).toEqual([]);
  });

  it('skips invalid packages and exposes a readable warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/catalog.json')) {
          return new Response(
            JSON.stringify({ version: 1, packages: [{ key: 'broken.CAI' }], folders: ['Furnish'] }),
            { status: 200 },
          );
        }
        return new Response(new Blob([Uint8Array.from([1, 2, 3]) as BlobPart]), { status: 200 });
      }),
    );
    const root = await new CaiCatalog('https://assets.example.test/').load();
    expect(root.folders[0]!.path).toBe('Furnish');
    expect(root.warnings?.[0]).toContain('broken.CAI');
  });
});
