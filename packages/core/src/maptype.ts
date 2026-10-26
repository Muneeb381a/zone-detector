/**
 * What kind of map a row is: an interactive ArcGIS map or a PDF, and how many PDF files sit behind its link.
 * One place decides it, so the table column, the filter, the summary and the CSV always agree. Results stored
 * before this existed carry no `mapType`; it is worked out from what they do have.
 */
import { isPdfUrl } from './pdf';
import { normalizeUrl } from './url';
import type { CheckResult, CheckRow, MapType } from './types';

export interface MapTypeInfo {
  type: MapType;
  /** Text for the table. */
  label: 'Interactive map' | 'PDF' | '—';
  /** PDF files behind the link: 1 for a PDF, the files listed on a web page, or those a viewer links to. */
  pdfCount: number;
  pdfLinks: string[];
  /** Where the answer comes from: the check itself, the shape of the link, or only the sheet's own type column. */
  basis: 'checked' | 'link' | 'sheet' | 'none';
  /** What the sheet's own type column says, when it has one. */
  sheetType?: 'interactive' | 'pdf';
  /** The sheet's type column and the check disagree (the sheet says PDF but the link is an ArcGIS service, or the other way round). */
  mismatch: boolean;
}

/** The type a link shows by its shape alone: a `.pdf` file, or an ArcGIS service / viewer address. */
export function typeFromUrl(url: string | undefined): MapType {
  const u = (url ?? '').trim();
  if (!u) return 'unknown';
  if (isPdfUrl(u)) return 'pdf';
  const n = normalizeUrl(u);
  return n.ok && n.kind !== 'Unknown' && n.kind !== 'Folder' ? 'interactive' : 'unknown';
}

/** "PDF", "ArcGIS", "AG" … as the sheet's type column writes it. */
export function sheetTypeOf(v: string | undefined): 'interactive' | 'pdf' | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (/pdf/.test(s)) return 'pdf';
  if (/^(ag|arcgis|esri|interactive|map|webmap|rest)\b/.test(s)) return 'interactive';
  return undefined;
}

const LABEL: Record<MapType, MapTypeInfo['label']> = { interactive: 'Interactive map', pdf: 'PDF', unknown: '—' };

export function mapTypeOf(row: Pick<CheckRow, 'url' | 'sheetType'> | undefined, result?: CheckResult): MapTypeInfo {
  const sheetType = sheetTypeOf(row?.sheetType);
  let type: MapType = 'unknown';
  let basis: MapTypeInfo['basis'] = 'none';
  if (result?.mapType && result.mapType !== 'unknown') {
    type = result.mapType;
    basis = 'checked';
  } else if (result?.serviceType === 'PDF') {
    type = 'pdf';
    basis = 'checked';
  } else if (result && (result.status === 'OK' || result.status === 'OK_NO_DATE') && result.serviceType) {
    type = 'interactive';
    basis = 'checked';
  } else {
    const byLink = typeFromUrl(result?.sourceUrl ?? row?.url);
    if (byLink !== 'unknown') {
      type = byLink;
      basis = 'link';
    }
  }
  if (type === 'unknown' && sheetType) {
    type = sheetType;
    basis = 'sheet';
  }
  const pdfLinks = result?.pdfLinks ?? [];
  const pdfCount = result?.pdfCount ?? (type === 'pdf' ? 1 : 0);
  return {
    type,
    label: LABEL[type],
    pdfCount: type === 'pdf' ? Math.max(pdfCount, 1) : pdfCount,
    pdfLinks,
    basis,
    sheetType,
    mismatch: !!sheetType && basis !== 'sheet' && type !== 'unknown' && sheetType !== type,
  };
}

export interface TypeSummary {
  interactive: number;
  pdf: number;
  unknown: number;
  /** Total PDF files across all rows (a web page listing three PDFs counts three). */
  pdfFiles: number;
  /** Rows where the sheet's type column and the link disagree. */
  mismatches: number;
}

export function summarizeTypes(rows: CheckRow[], results: Record<string, CheckResult>): TypeSummary {
  const s: TypeSummary = { interactive: 0, pdf: 0, unknown: 0, pdfFiles: 0, mismatches: 0 };
  for (const row of rows) {
    const t = mapTypeOf(row, results[row.id]);
    s[t.type]++;
    s.pdfFiles += t.pdfCount;
    if (t.mismatch) s.mismatches++;
  }
  return s;
}
