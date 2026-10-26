export type FailureCode =
  | 'URL_EMPTY'
  | 'URL_MALFORMED'
  | 'NOT_ARCGIS'
  | 'HTTP_404'
  | 'HTTP_410'
  | 'HTTP_401_403'
  | 'TOKEN_REQUIRED'
  | 'HTTP_429'
  | 'HTTP_5XX'
  | 'TIMEOUT'
  | 'DNS_FAIL'
  | 'SSL_ERROR'
  | 'CORS_BLOCKED'
  | 'SERVICE_STOPPED'
  | 'NO_LAYERS'
  | 'APP_URL_UNRESOLVED'
  | 'REDIRECT_LOOP'
  | 'MAP_RENDER_FAILED'
  | 'HOST_UNREACHABLE'
  // Not in PRD section 7; added because the taxonomy had no home for these.
  | 'CONNECTION_FAILED'
  | 'ARCGIS_ERROR';

export type WarningCode =
  | 'DUPLICATE_URL'
  | 'DATE_SENTINEL_IGNORED'
  | 'DATE_IN_FUTURE'
  | 'AMBIGUOUS_FORMAT'
  | 'DATE_FROM_PDF_PROPERTIES';

export type IssueCode = 'OK' | 'OK_NO_DATE' | FailureCode | WarningCode;

export interface IssueNote {
  code: IssueCode;
  reason: string;
}

export type DateKind = 'attribute' | 'editingInfo' | 'serviceProperty' | 'portalItem' | 'pdfText' | 'pdfProperty';
export type Confidence = 'high' | 'medium' | 'low';

/** One date found somewhere, with where it came from. Dates are UTC. */
export interface DateEvidence {
  /** YYYY-MM-DD, UTC */
  date: string;
  /** Full ISO timestamp, UTC */
  iso: string;
  kind: DateKind;
  /** e.g. `Attribute:LAST_EDIT_DATE`, `Service:editingInfo`, `Layer:editingInfo` */
  source: string;
  field?: string;
  layer?: string;
  layerId?: number;
  role: 'max' | 'min' | 'value';
  /** False for minimums and schema-edit dates: reported, but never chosen as the Primary Date. */
  primaryEligible: boolean;
  evidenceUrl: string;
  confidence: Confidence;
  future: boolean;
}

export interface LayerDetail {
  id: number;
  name: string;
  zoningScore: number;
  type?: string;
  geometryType?: string;
  matchedFields: string[];
  otherDateFields: string[];
  dates: DateEvidence[];
  /** Non-null value count per matched field, when the server reported it. */
  nonNullCounts: Record<string, number>;
  maxRecordCount?: number;
  note?: string;
  error?: string;
}

/** One map to check: a (cleaned) row from the sheet. */
export interface CheckRow {
  /** Unique id: `${sheetRow}` or `${sheetRow}.${n}` when a cell held several URLs. */
  id: string;
  /** 1-based spreadsheet row number (header is row 1). */
  sheetRow: number;
  city: string;
  state: string;
  county: string;
  url: string;
  fingerprint: string;
  /** Issues known before any request is made (e.g. DUPLICATE_URL). */
  preIssues: IssueNote[];
  /** Every original cell, keyed by header. */
  extra: Record<string, string>;
  /** The link came from another column because the Map URL cell had none. */
  fallback?: boolean;
  /** Header of the column the fallback link came from. */
  fallbackColumn?: string;
  /** What the sheet's own type column says about this map ("PDF", "ArcGIS"), when the sheet has one. */
  sheetType?: string;
  /** Shown with URL_EMPTY / URL_MALFORMED: what was looked for elsewhere in the row (a PDF is the usual reason a Map URL is empty). */
  hint?: string;
}

export type MapType = 'interactive' | 'pdf' | 'unknown';

export interface CheckResult {
  id: string;
  sheetRow: number;
  city: string;
  state: string;
  county: string;
  sourceUrl: string;
  /** The service actually checked. For a viewer link this is the service found behind it. */
  normalizedUrl: string;
  /** For viewer links: the portal items followed, ending at the service. */
  resolvedFrom?: string;
  serviceType: string;
  status: IssueCode;
  issues: IssueNote[];
  /** Human reason; empty for a clean OK. */
  issueReason: string;
  primaryDate: string;
  dateSource: string;
  dateConfidence: string;
  dateFieldName: string;
  attributeMaxDate: string;
  attributeMinDate: string;
  serviceEditingInfoDate: string;
  itemModifiedDate: string;
  allDates: DateEvidence[];
  otherDateFields: string[];
  zoningLayerName: string;
  layersChecked: number;
  layers: LayerDetail[];
  /** Local date (YYYY-MM-DD) of the check. */
  reviewDate: string;
  /** Full ISO timestamp of the check. */
  reviewedAt: string;
  reviewer: string;
  analystNote: string;
  evidenceUrl: string;
  responseTimeMs: number;
  retries: number;
  checkedAt: string;
  toolVersion: string;
  /** Result was reused from the 24 h URL cache instead of a fresh request. */
  fromCache?: boolean;
  /** The analyst pressed Mark as reviewed; reviewDate / reviewedAt are theirs, not the automatic check stamp. */
  manualReview?: boolean;
  /** Interactive ArcGIS map or PDF. Results stored before this field existed lack it; see mapTypeOf(). */
  mapType?: MapType;
  /** PDF files behind the link: 1 for a PDF, the files a web page lists, or those a viewer links to. */
  pdfCount?: number;
  /** Up to 20 of those PDF links. */
  pdfLinks?: string[];
  /** The browser re-check was tried and also failed; the server's result stands. */
  browserTried?: boolean;
  /** Where the check ran. `browser` = re-checked from the user's browser (e.g. behind a VPN). */
  via: 'server' | 'browser';
}
