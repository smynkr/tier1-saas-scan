// Local-time helpers. Day keys are the user's local calendar day (YYYY-MM-DD).

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY_KEY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** Add n calendar days to a day key (DST-safe: uses local noon). */
export function addDays(key: string, n: number): string {
  const m = DAY_KEY.exec(key);
  if (!m) throw new Error(`bad day key: ${key}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n, 12);
  return dayKey(d.getTime());
}

export interface HourPiece {
  day: string;
  hour: number;
  ms: number;
}

/**
 * Split [startMs, endMs) at local hour boundaries (which includes midnight).
 * DST-safe: the next boundary is computed with the local Date constructor, and
 * a non-advancing boundary falls back to +1h so the loop always terminates.
 */
export function splitByLocalHour(startMs: number, endMs: number): HourPiece[] {
  const pieces: HourPiece[] = [];
  let t = startMs;
  while (t < endMs) {
    const d = new Date(t);
    let next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    if (next <= t) next = t + 3_600_000;
    const pieceEnd = Math.min(next, endMs);
    pieces.push({ day: dayKey(t), hour: d.getHours(), ms: pieceEnd - t });
    t = pieceEnd;
  }
  return pieces;
}
