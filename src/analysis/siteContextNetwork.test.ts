import { afterEach, expect, it, vi } from 'vitest';
import { contextMapUrl, fetchSiteContext, parseContextMap } from './siteContext';
import { SITE_CONTEXT_URLS, siteContextHeaders } from '../../shared/siteContextNetwork';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const fixture: Parameters<typeof parseContextMap>[0] = { elements: [
  { type: 'node', id: 1, lat: 33.3, lon: 44.39 },
  { type: 'node', id: 2, lat: 33.3, lon: 44.391 },
  { type: 'node', id: 3, lat: 33.301, lon: 44.391 },
  { type: 'node', id: 4, lat: 34, lon: 45 },
  { type: 'node', id: 5, lat: 34, lon: 45.01 },
  { type: 'way', id: 10, tags: { building: 'yes', height: '8' }, nodes: [1, 2, 3, 1] },
  { type: 'way', id: 11, tags: { highway: 'residential' }, nodes: [1, 2] },
  { type: 'way', id: 12, tags: { highway: 'primary' }, nodes: [4, 5] },
  { type: 'way', id: 13, tags: { building: 'yes' }, nodes: [1, 2, 999, 1] },
] };

it('identifies only the scoped map services while preserving other headers', () => {
  expect(siteContextHeaders({ 'user-agent': 'Electron', REFERER: 'file://app', Accept: 'application/json' }, '0.2.2.31')).toEqual({
    'User-Agent': 'ArchAI/0.2.2.31 (https://github.com/Hussein5645/archai-studio)',
    Referer: 'https://github.com/Hussein5645/archai-studio', Accept: 'application/json',
  });
  expect(SITE_CONTEXT_URLS.every(url => url.startsWith('https://'))).toBe(true);
  expect(SITE_CONTEXT_URLS.some(url => url.includes('openstreetmap.org/api/0.6/map.json'))).toBe(true);
});

it('bounds the backup request and reconstructs complete ways, excluding missing nodes and distant roads', () => {
  expect(contextMapUrl(33.3, 44.39, 250)).toContain('/map.json?bbox=');
  expect(contextMapUrl(33.3, 44.39, 501)).toBeNull();
  expect(contextMapUrl(89, 0, 250)).toBeNull();
  expect(contextMapUrl(0, 179.9999, 250)).toBeNull();
  const features = parseContextMap(fixture, 33.3, 44.39, 250);
  expect(features.map(feature => feature.osmId)).toEqual([10, 11]);
  expect(features[0]!.size).toBe(8000);
});

it('includes crossing roads and buildings surrounding the circle even with every vertex outside', () => {
  const data: Parameters<typeof parseContextMap>[0] = { elements: [
    ...[[-0.01,-0.01],[-0.01,0.01],[0.01,0.01],[0.01,-0.01],[0,-0.01],[0,0.01]].map(([lat,lon],i)=>({type:'node',id:i+1,lat,lon})),
    {type:'way',id:30,tags:{building:'yes'},nodes:[1,2,3,4,1]},
    {type:'way',id:31,tags:{highway:'primary'},nodes:[5,6]},
  ] };
  expect(parseContextMap(data,0,0,100).map(feature=>feature.osmId)).toEqual([30,31]);
});

it('falls back after Overpass failures, coalesces downloads, and caches independent results', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (url: string) => url.includes('api.openstreetmap.org') ? Response.json(fixture) : new Response('',{status:500}));
  vi.stubGlobal('fetch',fetch);
  const first = fetchSiteContext(33.300001,44.39,250);
  const second = fetchSiteContext(33.300001,44.39,250);
  await vi.advanceTimersByTimeAsync(4001);
  const [a,b] = await Promise.all([first,second]);
  expect(a).toHaveLength(2);
  expect(b).toEqual(a);
  a[0]!.points[0]!.lat=0;
  expect(b[0]!.points[0]!.lat).toBe(33.3);
  expect(fetch.mock.calls.filter(([url])=>url.includes('api.openstreetmap.org'))).toHaveLength(1);
  const count=fetch.mock.calls.length;
  expect(await fetchSiteContext(33.300001,44.39,250)).toEqual(b);
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetch).toHaveBeenCalledTimes(count);
});

it('rejects partial Overpass responses with runtime errors and accepts the backup instead', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async (url:string)=>Response.json(url.includes('api.openstreetmap.org') ? fixture : {elements:[],remark:'runtime error: Query timed out'})));
  const pending=fetchSiteContext(33.300002,44.39,250);
  await vi.advanceTimersByTimeAsync(4001);
  expect(await pending).toHaveLength(2);
});

it('reports failures accurately and allows retry after a failed download', async () => {
  vi.useFakeTimers();
  const fetch=vi.fn(async()=>new Response('',{status:406}));
  vi.stubGlobal('fetch',fetch);
  const pending=expect(fetchSiteContext(33.300003,44.39,750)).rejects.toThrow(/500 m or less/);
  await vi.advanceTimersByTimeAsync(12001);
  await pending;
  fetch.mockImplementation(async()=>Response.json({elements:[]}));
  const retry=fetchSiteContext(33.300003,44.39,750);
  await vi.advanceTimersByTimeAsync(1);
  expect(await retry).toEqual([]);
});
