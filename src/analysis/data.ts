/**
 * Free, key-less open data: OpenStreetMap Nominatim for place search and Open-Meteo (ERA5
 * reanalysis archive + forecast metadata) for climate. Both require attribution, shown on the
 * map and in the Inspector.
 */
import type { WindData } from './model';

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

export interface Place {
  lat: number;
  lon: number;
  address: string;
}

export async function searchPlace(query: string): Promise<Place> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const results = await json<{ lat: string; lon: string; display_name: string }[]>(url);
  const first = results[0];
  if (!first) throw new Error(`No place found for "${query}"`);
  return { lat: Number(first.lat), lon: Number(first.lon), address: first.display_name };
}

export interface SiteDetails {
  elevation: number | null;
  utcOffset: number;
  timezone: string;
}

export async function siteDetails(lat: number, lon: number): Promise<SiteDetails> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto&forecast_days=1`;
  const data = await json<{ elevation?: number; utc_offset_seconds?: number; timezone?: string }>(url);
  return { elevation: typeof data.elevation === 'number' ? data.elevation : null, utcOffset: (data.utc_offset_seconds ?? 0) / 3600, timezone: data.timezone ?? 'UTC' };
}

function lastYear(): { from: string; to: string } {
  // The archive lags real time by several days.
  const to = new Date(Date.now() - 7 * 86_400_000);
  const from = new Date(to.getTime() - 365 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** 12 months of hourly 10 m wind reduced to a 16-sector rose, prevailing direction and mean speed. */
export async function windHistory(lat: number, lon: number): Promise<WindData> {
  const { from, to } = lastYear();
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${from}&end_date=${to}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=auto`;
  const data = await json<{ hourly?: { wind_speed_10m?: (number | null)[]; wind_direction_10m?: (number | null)[] } }>(url);
  const speeds = data.hourly?.wind_speed_10m ?? [];
  const directions = data.hourly?.wind_direction_10m ?? [];
  const rose = new Array<number>(16).fill(0);
  const speedBySector = new Array<number>(16).fill(0);
  let total = 0;
  for (let i = 0; i < speeds.length; i++) {
    const speed = speeds[i];
    const direction = directions[i];
    if (speed == null || direction == null) continue;
    const sector = Math.round(direction / 22.5) % 16;
    rose[sector]! += 1;
    speedBySector[sector]! += speed;
    total += 1;
  }
  if (total === 0) throw new Error('No wind records for this location');
  const prevailingSector = rose.indexOf(Math.max(...rose));
  return {
    prevailing: prevailingSector * 22.5,
    meanSpeed: speedBySector[prevailingSector]! / Math.max(1, rose[prevailingSector]!),
    rose: rose.map((count) => count / total),
    from,
    to,
  };
}

/** Mean daily sunshine duration (hours) over the last 12 months for the month of `date`. */
export async function sunshineForMonth(lat: number, lon: number, date: string): Promise<number> {
  const { from, to } = lastYear();
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${from}&end_date=${to}&daily=sunshine_duration&timezone=auto`;
  const data = await json<{ daily?: { time?: string[]; sunshine_duration?: (number | null)[] } }>(url);
  const month = date.slice(5, 7);
  const values = (data.daily?.time ?? []).flatMap((day, i) => {
    const seconds = data.daily?.sunshine_duration?.[i];
    return day.slice(5, 7) === month && seconds != null ? [seconds / 3600] : [];
  });
  if (values.length === 0) throw new Error('No sunshine records for this month');
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

let lastPosition: Place | null = null;

/** The device position from the browser (asks for permission once); cached for the session. */
export async function userPosition(): Promise<{ lat: number; lon: number }> {
  if (lastPosition) return lastPosition;
  if (typeof navigator === 'undefined' || !navigator.geolocation) throw new Error('Location is not available on this device');
  const position = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, (error) => reject(new Error(error.code === error.PERMISSION_DENIED ? 'Location permission was denied' : 'Could not determine your location')), { enableHighAccuracy: true, timeout: 15_000, maximumAge: 600_000 }),
  );
  lastPosition = { lat: position.coords.latitude, lon: position.coords.longitude, address: '' };
  return lastPosition;
}

/** Nearest address for a point (OpenStreetMap Nominatim), or '' when there is none. */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&lat=${lat}&lon=${lon}`;
  const result = await json<{ display_name?: string }>(url);
  return result.display_name ?? '';
}
