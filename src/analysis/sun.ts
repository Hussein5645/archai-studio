/**
 * Solar position from the standard low-precision astronomical formulas (ecliptic longitude,
 * sidereal time), accurate to a fraction of a degree, which is well below what shadow studies
 * need. Angles are radians; azimuth is measured clockwise from true north.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397;

function daysSinceJ2000(utcMs: number): number {
  return utcMs / DAY_MS - 0.5 + J1970 - J2000;
}

function sunCoords(days: number): { declination: number; rightAscension: number } {
  const meanAnomaly = RAD * (357.5291 + 0.98560028 * days);
  const centre = RAD * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly));
  const longitude = meanAnomaly + centre + RAD * 102.9372 + Math.PI;
  return {
    declination: Math.asin(Math.sin(longitude) * Math.sin(OBLIQUITY)),
    rightAscension: Math.atan2(Math.sin(longitude) * Math.cos(OBLIQUITY), Math.cos(longitude)),
  };
}

export interface SunPosition {
  /** Clockwise from true north. */
  azimuth: number;
  /** Above the horizon; negative at night. */
  altitude: number;
}

export function sunPosition(utcMs: number, latitude: number, longitude: number): SunPosition {
  const days = daysSinceJ2000(utcMs);
  const phi = RAD * latitude;
  const { declination, rightAscension } = sunCoords(days);
  const hourAngle = RAD * (280.16 + 360.9856235 * days) + RAD * longitude - rightAscension;
  const fromSouth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi));
  const altitude = Math.asin(Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle));
  return { azimuth: (fromSouth + Math.PI) % (2 * Math.PI), altitude };
}

/** UTC milliseconds for a local wall-clock date ("YYYY-MM-DD") and time ("HH:MM") at a UTC offset in hours. */
export function localToUtc(date: string, time: string, utcOffsetHours: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1, hh ?? 12, mm ?? 0) - utcOffsetHours * 3_600_000;
}

/**
 * Unit vector towards the sun in scene space (x = board x, y = up, z = board y). `northAngle` is
 * the board direction of true north, in degrees clockwise from the board's up.
 */
export function sunDirection(position: SunPosition, northAngle: number): [number, number, number] {
  const north = northAngle * RAD;
  const bearing = north + position.azimuth;
  const horizontal = Math.cos(position.altitude);
  return [Math.sin(bearing) * horizontal, Math.sin(position.altitude), -Math.cos(bearing) * horizontal];
}

/** Board-plane unit vector for a compass bearing (degrees clockwise from true north). */
export function compassVector(bearingDeg: number, northAngle: number): [number, number] {
  const angle = (northAngle + bearingDeg) * RAD;
  return [Math.sin(angle), -Math.cos(angle)];
}

/** Sun directions sampled across a day while the sun is up, each worth `hours` of exposure. */
export function daySamples(date: string, utcOffsetHours: number, latitude: number, longitude: number, northAngle: number, stepMinutes = 60): { dir: [number, number, number]; hours: number }[] {
  const start = localToUtc(date, '00:00', utcOffsetHours);
  const samples: { dir: [number, number, number]; hours: number }[] = [];
  for (let minute = stepMinutes / 2; minute < 24 * 60; minute += stepMinutes) {
    const position = sunPosition(start + minute * 60_000, latitude, longitude);
    if (position.altitude > RAD * 1) samples.push({ dir: sunDirection(position, northAngle), hours: stepMinutes / 60 });
  }
  return samples;
}
