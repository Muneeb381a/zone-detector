/**
 * Google Sheet input (PRD section 4): URL parsing, CSV parsing, column auto-mapping,
 * row cleaning, duplicate flagging and fingerprints.
 */
import type { CheckRow, IssueNote } from './types';
import { normalizeUrl } from './url';

export class SheetError extends Error {
  constructor(
    public code: 'SHEET_URL_INVALID' | 'SHEET_PRIVATE' | 'SHEET_EMPTY' | 'SHEET_FETCH_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SheetError';
  }
}

export interface SheetRef {
  sheetId: string;
  gid: string;
}

export function parseSheetUrl(input: string): SheetRef {
  const s = (input ?? '').trim();
  const m = /docs\.google\.com\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/.exec(s);
  if (!m) throw new SheetError('SHEET_URL_INVALID', 'That is not a Google Sheets link. Paste the address from the sheet\'s browser tab.');
  const gid = /[#?&]gid=(\d+)/.exec(s);
  return { sheetId: m[1], gid: gid ? gid[1] : '0' };
}

export function csvExportUrl(ref: SheetRef): string {
  return `https://docs.google.com/spreadsheets/d/${ref.sheetId}/export?format=csv&gid=${ref.gid}`;
}

/** Google answers a private sheet with an HTML sign-in page instead of CSV. */
export function assertCsvResponse(status: number, body: string): void {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  if (status === 401 || status === 403 || head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<title>sign in')) {
    throw new SheetError('SHEET_PRIVATE', 'Sheet is private. Share as "Anyone with the link" or sign in with Google.');
  }
  if (status === 404) {
    throw new SheetError('SHEET_FETCH_FAILED', 'Google could not find that sheet (404). Check the link.');
  }
  if (status < 200 || status >= 300) {
    throw new SheetError('SHEET_FETCH_FAILED', `Google returned HTTP ${status} for that sheet.`);
  }
}

/** RFC 4180 CSV: quoted fields, doubled quotes, embedded newlines, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  city: number | null;
  state: number | null;
  county: number | null;
  url: number | null;
  /**
   * Link column used only for rows whose Map URL cell holds no link (a viewer link, or the PDF that a city
   * publishes instead of an ArcGIS service). `undefined` = automatic: the sheet's other link columns are
   * searched, a PDF link first; `null` = off; a number = that column.
   */
  altUrl?: number | null;
  /**
   * The sheet's own City ID column. `undefined` = automatic (see findIdColumn), `null` = none, a number = that column.
   */
  id?: number | null;
}

// Headers are sometimes decorated with counts ("183 - Cities"); drop the count so the name still matches.
const norm = (s: string) => s.toLowerCase().replace(/^\s*\d+\s*[-–:]\s*/, '').replace(/[^a-z0-9]/g, '');

type MapKey = 'city' | 'state' | 'county' | 'url';
const SYNONYMS: Record<MapKey, string[]> = {
  city: ['city', 'cities', 'municipalities', 'municipality', 'municipalityname', 'cityname', 'citytown', 'cityormunicipality', 'town', 'jurisdiction', 'place', 'muni', 'localgovernment', 'name'],
  state: ['state', 'states', 'st', 'stateabbr', 'stateabbreviation', 'statecode', 'stateprovince'],
  county: ['county', 'counties', 'countyname', 'parish', 'borough'],
  url: ['mapurl', 'url', 'link', 'endpoint', 'endpointlinks', 'endpointlink', 'endpoints', 'maplink', 'zoningmap', 'zoningmapurl', 'zoningurl', 'zoninglink', 'arcgisurl', 'arcgislink', 'restendpoint', 'interactivemap', 'interactivemapurl', 'webmap', 'gisurl', 'gislink', 'mapendpoint', 'serviceurl'],
};

const CELL_URL = /https?:\/\//i;

export function suggestMapping(headers: string[], sampleRows: string[][] = []): ColumnMapping {
  const normHeaders = headers.map(norm);
  const taken = new Set<number>();
  const pick = (key: MapKey): number | null => {
    for (const syn of SYNONYMS[key]) {
      const i = normHeaders.findIndex((h, idx) => h === syn && !taken.has(idx));
      if (i >= 0) return i;
    }
    // Looser: header contains the main word ("Zoning Map URL", "City / Town").
    const main = SYNONYMS[key].slice(0, key === 'url' ? 3 : 1);
    for (const word of main) {
      const i = normHeaders.findIndex((h, idx) => h.includes(word) && !taken.has(idx) && !(key === 'city' && h.includes('county')));
      if (i >= 0) return i;
    }
    return null;
  };

  const mapping: ColumnMapping = { city: null, state: null, county: null, url: null };
  // URL first so a header like "City Map URL" is not claimed as the city column.
  for (const key of ['url', 'county', 'state', 'city'] as const) {
    const i = pick(key);
    mapping[key] = i;
    if (i !== null) taken.add(i);
  }

  // Content fallback: pick the column where most non-empty cells hold a link.
  if (mapping.url === null && sampleRows.length > 0) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < headers.length; c++) {
      if (taken.has(c)) continue;
      const cells = sampleRows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
      if (cells.length === 0) continue;
      const score = cells.filter((x) => CELL_URL.test(x)).length / cells.length;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best >= 0 && bestScore >= 0.5) mapping.url = best;
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

const INVISIBLE = /[​-‍⁠﻿­]/g;

export function cleanCell(s: string | undefined): string {
  return (s ?? '').replace(INVISIBLE, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** URLs inside a cell that may carry extra words ("Zoning: https://… (updated 2023)") or several links. */
export function extractUrls(cell: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"'`]+/gi;
  for (const m of cell.matchAll(re)) {
    // Drop punctuation that belongs to the sentence, and an unbalanced closing bracket.
    let u = m[0].replace(/[.,;:!?]+$/, '');
    while (/[)\]]$/.test(u) && !u.includes(u.endsWith(')') ? '(' : '[')) u = u.slice(0, -1);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

const ID_SYNONYMS = ['cityid', 'id', 'ids', 'mapid', 'recordid', 'municipalityid', 'jurisdictionid', 'placeid', 'gisid', 'cityids', 'idno', 'idnumber'];
const NOT_ID = /^(valid|paid|grid|guid|rapid|solid|fluid|humid|void|android|covid)s?$/;

/**
 * Where the sheet keeps its own City ID. A chosen column wins; otherwise: a header that is "ID" / "City ID" / "IDs"
 * (a count in front or behind, as in "100 - IDs" or "ID (100)", is ignored), then any header ending in ID (Map_ID),
 * then the column just left of the City column, where IDs normally sit. -1 when there is none.
 */
export function findIdColumn(table: string[][], mapping: ColumnMapping): number {
  if (mapping.id === null) return -1;
  if (mapping.id !== undefined) return mapping.id;
  const headers = (table[0] ?? []).map(cleanCell);
  const taken = new Set([mapping.city, mapping.state, mapping.county, mapping.url, mapping.altUrl].filter((x): x is number => x != null));
  const keys = headers.map((h) => norm(h).replace(/\d+$/, ''));
  for (const syn of ID_SYNONYMS) {
    const i = keys.findIndex((k, c) => k === syn && !taken.has(c));
    if (i >= 0) return i;
  }
  const ends = keys.findIndex((k, c) => !taken.has(c) && k.length > 2 && /ids?$/.test(k) && !NOT_ID.test(k));
  if (ends >= 0) return ends;
  const left = mapping.city;
  if (left != null && left > 0 && !taken.has(left - 1)) {
    const vals = table.slice(1).map((r) => cleanCell(r[left - 1])).filter(Boolean);
    // Only if it looks like identifiers: filled, short, and (nearly) all different.
    if (vals.length > 0 && vals.every((v) => v.length <= 20) && new Set(vals).size >= vals.length * 0.9) return left - 1;
  }
  return -1;
}

const PDF_LINK = /\.pdf(?:$|[?#])/i;
const hasPdfLink = (urls: string[]) => urls.find((u) => PDF_LINK.test(u));

/**
 * The columns searched when a row has no Map URL and no fallback column was chosen: columns that hold links,
 * viewer/map-link columns first (they also resolve to a map), then PDF / future-land-use / document columns,
 * then any other column with links.
 */
export function autoFallbackColumns(table: string[][], mapping: ColumnMapping): number[] {
  const headers = (table[0] ?? []).map(cleanCell);
  const taken = new Set([mapping.city, mapping.state, mapping.county, mapping.url].filter((x): x is number => x != null));
  const rank = (h: string): number => {
    const n = norm(h);
    if (/tml|maplink|viewer|webmap|webapp|interactive/.test(n)) return 0;
    if (/pdf|flum|document|plan|ordinance|code/.test(n)) return 1;
    return /link|url/.test(n) ? 2 : 3;
  };
  const cols: { c: number; r: number }[] = [];
  headers.forEach((h, c) => {
    if (taken.has(c)) return;
    if (!table.slice(1).some((r) => CELL_URL.test(r[c] ?? ''))) return;
    const r = rank(h);
    if (r <= 2) cols.push({ c, r }); // columns with an unrelated header (emails, notes) are not searched for a map
  });
  return cols.sort((a, b) => a.r - b.r || a.c - b.c).map((x) => x.c);
}

/** The sheet's own "type" column (values like PDF / ArcGIS), found by its header ("PDF: 2 | AG: 98") or its values. */
function findTypeColumn(table: string[][]): number | null {
  const headers = (table[0] ?? []).map(cleanCell);
  const byHeader = headers.findIndex((h) => /\bpdf\s*:\s*\d+/i.test(h) && /\b(ag|arcgis)\s*:\s*\d+/i.test(h));
  if (byHeader >= 0) return byHeader;
  for (let c = 0; c < headers.length; c++) {
    const vals = new Set(table.slice(1).map((r) => cleanCell(r[c]).toLowerCase()).filter(Boolean));
    if (vals.size > 0 && vals.size <= 6 && vals.has('pdf') && [...vals].every((v) => ['pdf', 'arcgis', 'ag', 'image', 'i', 'unknown', 'u', 'other'].includes(v))) return c;
  }
  return null;
}

/** Small 53-bit string hash, synchronous so it also runs in the browser. */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Fingerprint of City + State + URL, used by re-sync (Phase 2) to find new or changed rows. */
export function fingerprint(city: string, state: string, url: string): string {
  return hashString([city, state, url].map((x) => x.trim().toLowerCase()).join('\u0001'));
}

export interface BuildResult {
  rows: CheckRow[];
  blankDropped: number;
  split: number;
  duplicates: number;
}

/**
 * Turn the parsed table into rows to check. `table[0]` is the header row.
 * Blank rows are dropped; rows with a city but no usable link are kept so they report URL_EMPTY / URL_MALFORMED.
 */
export function buildRows(table: string[][], mapping: ColumnMapping): BuildResult {
  const headers = (table[0] ?? []).map(cleanCell);
  const cell = (r: string[], i: number | null) => (i === null ? '' : cleanCell(r[i]));
  const rows: CheckRow[] = [];
  const typeCol = findTypeColumn(table);
  const idCol = findIdColumn(table, mapping);
  const fallbackCols = mapping.altUrl === null ? [] : mapping.altUrl !== undefined ? [mapping.altUrl] : autoFallbackColumns(table, mapping);
  let blankDropped = 0;
  let split = 0;

  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const city = cell(r, mapping.city);
    const state = cell(r, mapping.state);
    const county = cell(r, mapping.county);
    const urlCell = cell(r, mapping.url);
    if (!city && !state && !county && !urlCell) {
      blankDropped++;
      continue;
    }
    const sheetRow = i + 1;
    const extra: Record<string, string> = {};
    headers.forEach((h, c) => {
      extra[h || `Column ${c + 1}`] = cleanCell(r[c]);
    });

    const sheetType = typeCol === null ? '' : cell(r, typeCol);
    const cityId = idCol >= 0 ? cell(r, idCol) : '';
    let urls = extractUrls(urlCell);
    let fallback = false;
    let fallbackColumn: string | undefined;
    let hint: string | undefined;
    if (urls.length === 0 && mapping.altUrl !== null) {
      // A Map URL that is empty is usually a PDF map. Look in the row's other link columns: a PDF link wins,
      // otherwise the first viewer / map link (it is resolved to its map like any other).
      const found = fallbackCols.map((c) => ({ c, urls: extractUrls(cell(r, c)) })).filter((x) => x.urls.length > 0);
      const withPdf = found.find((x) => hasPdfLink(x.urls));
      const pick = withPdf ?? found[0];
      if (pick) {
        urls = withPdf ? [hasPdfLink(pick.urls)!] : pick.urls;
        fallback = true;
        fallbackColumn = headers[pick.c] || `Column ${pick.c + 1}`;
      } else if (mapping.altUrl === undefined) {
        // Last resort when no link column exists: any cell in the row holding a link to a PDF.
        for (let c = 0; c < headers.length && !fallback; c++) {
          const pdf = c === mapping.url ? undefined : hasPdfLink(extractUrls(cell(r, c)));
          if (pdf) {
            urls = [pdf];
            fallback = true;
            fallbackColumn = headers[c] || `Column ${c + 1}`;
          }
        }
      }
    }
    if (urls.length === 0) {
      const type = sheetType;
      const looked = fallbackCols.map((c) => headers[c] || `Column ${c + 1}`);
      hint = `${/pdf/i.test(type) ? 'The sheet marks this map as a PDF, but no PDF link' : 'No PDF or viewer link'} was found in this row${looked.length ? ` (looked in: ${looked.join(', ')})` : ''}. Paste the PDF or map link into the Map URL cell.`;
    }
    if (urls.length === 0) urls = [urlCell]; // let normalizeUrl decide: empty -> URL_EMPTY, "N/A" -> URL_MALFORMED, bare domain -> ok
    if (urls.length > 1) split += urls.length - 1;
    urls.forEach((url, n) => {
      rows.push({
        id: urls.length > 1 ? `${sheetRow}.${n + 1}` : String(sheetRow),
        sheetRow,
        city,
        state,
        county,
        url,
        fingerprint: fingerprint(city, state, url),
        preIssues: [],
        extra,
        ...(cityId ? { cityId } : {}),
        ...(sheetType ? { sheetType } : {}),
        ...(fallback ? { fallback: true, fallbackColumn } : {}),
        ...(hint ? { hint } : {}),
      });
    });
  }

  const duplicates = flagDuplicates(rows);
  return { rows, blankDropped, split, duplicates };
}

/**
 * Rows saved by an earlier version lack fields read from the sheet since (City ID, the sheet's type, the hint and
 * fallback column). Rebuild the sheet's rows and copy those fields onto the saved rows whose link has not changed,
 * so nothing is re-checked and nothing else about the saved rows moves.
 */
export function refreshRowFields(saved: CheckRow[], table: string[][] | null | undefined, mapping: ColumnMapping | null | undefined): CheckRow[] {
  if (!table || !mapping || mapping.url == null) return saved;
  const fresh = new Map(buildRows(table, mapping).rows.map((r) => [r.id, r]));
  return saved.map((row) => {
    const f = fresh.get(row.id);
    if (!f || f.fingerprint !== row.fingerprint) return row;
    const { cityId, sheetType, hint, fallback, fallbackColumn } = f;
    const next = { ...row, cityId, sheetType, hint, fallback: fallback ?? row.fallback, fallbackColumn };
    for (const k of ['cityId', 'sheetType', 'hint', 'fallbackColumn'] as const) if (next[k] === undefined) delete next[k];
    return next;
  });
}

/** Marks every row whose link appears more than once. Rows are kept. Returns the number of flagged rows. */
export function flagDuplicates(rows: CheckRow[]): number {
  const groups = new Map<string, CheckRow[]>();
  for (const row of rows) {
    const n = normalizeUrl(row.url);
    if (!n.ok) continue;
    const list = groups.get(n.canonical) ?? [];
    list.push(row);
    groups.set(n.canonical, list);
  }
  let flagged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const where = list.map((r) => `row ${r.id}`).join(', ');
    for (const row of list) {
      const note: IssueNote = { code: 'DUPLICATE_URL', reason: `This link appears ${list.length} times (${where}).` };
      row.preIssues = [...row.preIssues.filter((x) => x.code !== 'DUPLICATE_URL'), note];
      flagged++;
    }
  }
  return flagged;
}
