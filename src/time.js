export const TZ = process.env.GAME_TZ || 'Europe/Lisbon';

let fixedNow = null;
export function setNow(d) { fixedNow = d ? new Date(d) : null; } // tests only
export const now = () => (fixedNow ? new Date(fixedNow) : new Date());

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const today = () => fmt.format(now()); // YYYY-MM-DD in GAME_TZ
export const seasonOf = (day) => day.slice(0, 7);

const toUtc = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day, n) => fromUtc(toUtc(day) + n * 86400000);
export const dayIndex = (day) => Math.floor(toUtc(day) / 86400000);

export function daysLeft(day) {
  const y = +day.slice(0, 4), m = +day.slice(5, 7);
  const next = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  return Math.max(1, Math.round((next - toUtc(day)) / 86400000));
}

export function prevSeason(season) {
  let y = +season.slice(0, 4), m = +season.slice(5, 7) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
export const SEASON_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
