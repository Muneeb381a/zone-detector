/**
 * PDF maps (a city that publishes its zoning map as a PDF instead of an ArcGIS service).
 * The Primary Date is a date written in the document's text; when the text has none, the PDF's
 * document properties (ModDate, then CreationDate) are used. Reading the file is injected (`PdfReader`),
 * so this module stays pure and runs anywhere; the Node server supplies a reader built on pdf.js.
 */

export interface PdfContent {
  /** Text of the first pages, in reading order. */
  text: string;
  /** Raw document properties as stored in the file (PDF date strings such as `D:20230514103000+05'00'`). */
  info: { creationDate?: string; modDate?: string; title?: string };
  pages: number;
}

export type PdfReader = (bytes: Uint8Array) => Promise<PdfContent>;

export const isPdfUrl = (url: string) => /\.pdf(?:$|[?#])/i.test(url.trim());
export const isPdfContentType = (ct: string | undefined) => /application\/(x-)?pdf/i.test(ct ?? '');
export const looksLikePdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIndex = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3).toLowerCase()));

function valid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** `D:20230514103000+05'00'` (the prefix, time and zone are all optional past the year) → `YYYY-MM-DD` in UTC, or null. */
export function parsePdfDate(s: string | undefined | null): { date: string; iso: string } | null {
  if (!s) return null;
  const m = /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{2}(?:'?\d{2}'?)?)?/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2] ?? '01', m[3] ?? '01', m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number);
  if (!valid(y, mo, d)) return null;
  let ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const z = m[7];
  if (z && z !== 'Z') {
    const zm = /([+-])(\d{2})(?:'?(\d{2}))?/.exec(z);
    if (zm) ms -= (zm[1] === '-' ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3] ?? 0)) * 60_000; // to UTC
  }
  const dt = new Date(ms);
  return { date: dt.toISOString().slice(0, 10), iso: dt.toISOString() };
}

export interface TextDate {
  date: string;
  /** The words that led to it ("Last Revised"), when the date sits next to one. */
  keyword?: string;
  /** Format the date was written in; slash dates are read month-first (US) unless the first number cannot be a month. */
  format: 'month-name' | 'iso' | 'slash' | 'month-year';
  /** Both numbers of a slash date could be the month, so day/month order is a guess. */
  ambiguous?: boolean;
  snippet: string;
  /** Character offset in the cleaned text (document order). */
  at: number;
}

const KEYWORD_RE = /(last\s+(?:revised|updated|modified|amended|edited)|revis(?:ed|ion)(?:\s+date)?|updated?|amended|amendment|adopted|adoption|effective(?:\s+date)?|as\s+of|date\s+(?:printed|prepared|published|created|issued)|printed|prepared|published|dated?|rev\.?)\W{0,3}(?:on\W{0,3})?(?:through\W{0,3})?$/i;

function keywordBefore(text: string, index: number): string | undefined {
  const before = text.slice(Math.max(0, index - 36), index);
  const m = KEYWORD_RE.exec(before);
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
}

/**
 * Every date written in the text, with the label it sits behind where there is one. Order of the result is
 * document order. Dates in the future and years before 1990 are dropped (map numbers and ordinance numbers
 * such as "1987-45" are not dates).
 */
export function findTextDates(text: string, now = new Date()): TextDate[] {
  const out: TextDate[] = [];
  const clean = text.replace(/[ \t ]+/g, ' ');
  const today = iso(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const spans: [number, number][] = [];
  const add = (idx: number, len: number, date: string, format: TextDate['format'], ambiguous = false) => {
    if (date > today || date < '1990-01-01') return;
    spans.push([idx, idx + len]);
    out.push({ date, keyword: keywordBefore(clean, idx), format, ambiguous: ambiguous || undefined, at: idx, snippet: clean.slice(Math.max(0, idx - 24), idx + len + 6).replace(/\s+/g, ' ').trim() });
  };
  let m: RegExpExecArray | null;

  // June 5, 2023 · Jun. 5th 2023
  const mdy = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  while ((m = mdy.exec(clean))) if (valid(+m[3], monthIndex(m[1]) + 1, +m[2])) add(m.index, m[0].length, iso(+m[3], monthIndex(m[1]) + 1, +m[2]), 'month-name');

  // 5 June 2023
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi');
  while ((m = dmy.exec(clean))) if (valid(+m[3], monthIndex(m[2]) + 1, +m[1])) add(m.index, m[0].length, iso(+m[3], monthIndex(m[2]) + 1, +m[1]), 'month-name');

  // 2023-06-05 · 2023/06/05
  const ymd = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = ymd.exec(clean))) if (valid(+m[1], +m[2], +m[3])) add(m.index, m[0].length, iso(+m[1], +m[2], +m[3]), 'iso');

  // 06/05/2023 · 6-5-23 (US month-first; day-first only when the first number cannot be a month)
  const slash = /(?<![\d/-])(?<!\d\.)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?![\d/-])(?!\.\d)/g;
  while ((m = slash.exec(clean))) {
    const a = +m[1], b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a <= 12 && valid(y, a, b)) add(m.index, m[0].length, iso(y, a, b), 'slash', a !== b && b <= 12);
    else if (a > 12 && valid(y, b, a)) add(m.index, m[0].length, iso(y, b, a), 'slash');
  }

  // May 2021 (no day: the first of the month, and only trusted next to a label)
  const my = new RegExp(`\\b${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi');
  while ((m = my.exec(clean))) {
    const mon = monthIndex(m[1]) + 1;
    if (!valid(+m[2], mon, 1)) continue;
    const [from, to] = [m.index, m.index + m[0].length];
    if (spans.some(([a, b]) => from < b && to > a)) continue; // already part of a full date
    if (keywordBefore(clean, m.index)) add(m.index, m[0].length, iso(+m[2], mon, 1), 'month-year');
  }

  return out.sort((a, b) => a.at - b.at);
}

/** The date to use from the text: the newest one that sits behind a label, otherwise the newest of all. */
export function pickTextDate(dates: TextDate[]): TextDate | null {
  if (dates.length === 0) return null;
  const newest = (xs: TextDate[]) => xs.reduce((best, d) => (d.date > best.date ? d : best));
  const labelled = dates.filter((d) => d.keyword);
  return newest(labelled.length ? labelled : dates);
}
