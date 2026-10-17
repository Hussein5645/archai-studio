/** Only these public geographic-data requests receive ArchAI's service identity. */
export const SITE_CONTEXT_URLS = [
  'https://overpass-api.de/api/interpreter*',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter*',
  'https://overpass.kumi.systems/api/interpreter*',
  'https://overpass.private.coffee/api/interpreter*',
  'https://api.openstreetmap.org/api/0.6/map.json*',
];

export function siteContextHeaders(headers: Record<string, string>, version: string): Record<string, string> {
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) => !['user-agent', 'referer'].includes(key.toLowerCase())));
  return { ...result, 'User-Agent': `ArchAI/${version} (https://github.com/Hussein5645/archai-studio)`, Referer: 'https://github.com/Hussein5645/archai-studio' };
}
