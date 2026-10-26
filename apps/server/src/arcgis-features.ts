/**
 * Downloading the features of one ArcGIS layer: metadata, a feature count, then pages of features as GeoJSON in WGS 84.
 * Servers that cannot answer `f=geojson` are asked for Esri JSON instead and converted here.
 */
import { AbortedError, HttpError, type HttpClient } from '@zoning/core';
import type { GeoJsonFeature, GeoJsonGeometry, GpkgColumn, GpkgColumnType } from './geopackage';

export class FeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureError';
  }
}

export interface LayerField {
  name: string;
  type: string;
  alias?: string;
}

export interface LayerMeta {
  id: number;
  name: string;
  /** "Feature Layer", "Table", "Raster Layer" … */
  type: string;
  geometryType?: string;
  maxRecordCount: number;
  objectIdField?: string;
  fields: LayerField[];
  supportsPagination: boolean;
  /** The service allows queries on this layer (capabilities include Query). */
  queryable: boolean;
}

export interface FetchOptions {
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Stop after this many features. */
  maxFeatures?: number;
  /** Features asked for per request, at most (further capped by the layer's maxRecordCount). */
  pageSize?: number;
  retries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const trimUrl = (u: string) => u.split('?')[0].replace(/\/+$/, '');
const qs = (p: Record<string, string | number | boolean | undefined>) =>
  Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

/** GET JSON with retries on timeouts, connection failures, 429 and 5xx. ArcGIS errors (JSON `error`) become FeatureError. */
async function getJson(http: HttpClient, url: string, o: FetchOptions): Promise<any> {
  const sleep = o.sleep ?? defaultSleep;
  const attempts = (o.retries ?? 2) + 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (o.signal?.aborted) throw new AbortedError();
    try {
      const res = await http.get(url, { signal: o.signal });
      if (res.status === 429 || res.status >= 500) throw new FeatureError(`Server error (${res.status}).`);
      if (res.status === 401 || res.status === 403) throw new FeatureError(`Access denied (${res.status}). The layer is secured, or the server blocks this location.`);
      if (res.status === 404) throw new FeatureError('Not found (404).');
      let json: any;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new FeatureError('The server did not return JSON.');
      }
      if (json?.error) {
        const code = json.error.code;
        const msg = [json.error.message, ...(json.error.details ?? [])].filter(Boolean).join(' ');
        if (code === 498 || code === 499) throw new FeatureError('The layer requires a token (secured service).');
        throw Object.assign(new FeatureError(`ArcGIS error${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`), { arcgisCode: code });
      }
      return json;
    } catch (e) {
      if (o.signal?.aborted || e instanceof AbortedError) throw new AbortedError();
      last = e;
      const retryable = (e instanceof FeatureError && /^Server error/.test(e.message)) || (e instanceof HttpError && ['TIMEOUT', 'CONNECTION_FAILED'].includes(e.code));
      if (!retryable || i === attempts - 1) break;
      await sleep(500 * 2 ** i);
    }
  }
  if (last instanceof HttpError) {
    if (last.code === 'TOO_LARGE') throw Object.assign(new FeatureError('The response was larger than the download limit.'), { tooLarge: true });
    throw new FeatureError(`Could not reach the server (${last.code}${last.message ? `: ${last.message}` : ''}).`);
  }
  throw last instanceof Error ? last : new FeatureError(String(last));
}

/** The layers a service lists (group layers are marked, they hold no features themselves). */
export async function readServiceLayers(http: HttpClient, serviceUrl: string, o: FetchOptions = {}): Promise<{ id: number; name: string; group: boolean }[]> {
  const j = await getJson(http, `${trimUrl(serviceUrl)}?f=json`, o);
  const layers: any[] = Array.isArray(j.layers) ? j.layers : [];
  return layers.map((l) => ({ id: Number(l.id), name: String(l.name ?? `Layer ${l.id}`), group: Array.isArray(l.subLayerIds) && l.subLayerIds.length > 0 }));
}

export async function readLayerMeta(http: HttpClient, layerUrl: string, o: FetchOptions = {}): Promise<LayerMeta> {
  const url = trimUrl(layerUrl);
  const j = await getJson(http, `${url}?f=json`, o);
  const id = Number(/\/(\d+)$/.exec(url)?.[1] ?? j.id ?? 0);
  const fields: LayerField[] = Array.isArray(j.fields) ? j.fields.map((f: any) => ({ name: String(f.name), type: String(f.type), alias: f.alias ? String(f.alias) : undefined })) : [];
  const oid = j.objectIdField ?? fields.find((f) => f.type === 'esriFieldTypeOID')?.name;
  const caps = String(j.capabilities ?? 'Query');
  return {
    id,
    name: String(j.name ?? `Layer ${id}`),
    type: String(j.type ?? 'Feature Layer'),
    geometryType: j.geometryType,
    maxRecordCount: Number(j.maxRecordCount) > 0 ? Number(j.maxRecordCount) : 1000,
    objectIdField: oid,
    fields,
    supportsPagination: j.advancedQueryCapabilities?.supportsPagination === true || j.supportsPagination === true,
    queryable: /query/i.test(caps),
  };
}

const COLUMN_TYPES: Record<string, GpkgColumnType | null> = {
  esriFieldTypeOID: 'INTEGER',
  esriFieldTypeSmallInteger: 'INTEGER',
  esriFieldTypeInteger: 'INTEGER',
  esriFieldTypeBigInteger: 'INTEGER',
  esriFieldTypeSingle: 'REAL',
  esriFieldTypeDouble: 'REAL',
  esriFieldTypeDate: 'DATETIME',
  esriFieldTypeDateOnly: 'DATETIME',
  esriFieldTypeTimestampOffset: 'DATETIME',
  esriFieldTypeString: 'TEXT',
  esriFieldTypeGUID: 'TEXT',
  esriFieldTypeGlobalID: 'TEXT',
  esriFieldTypeXML: 'TEXT',
  esriFieldTypeGeometry: null,
  esriFieldTypeBlob: null,
  esriFieldTypeRaster: null,
};

/** Attribute columns for the GeoPackage table: every attribute field except the geometry and binary ones. */
export function columnsFor(meta: LayerMeta): GpkgColumn[] {
  return meta.fields
    .filter((f) => !/^shape$/i.test(f.name) && COLUMN_TYPES[f.type] !== null)
    .map((f) => ({ source: f.name, type: COLUMN_TYPES[f.type] ?? 'TEXT' }));
}

// ---------------------------------------------------------------------------
// Esri JSON -> GeoJSON (only used when the server cannot answer f=geojson)
// ---------------------------------------------------------------------------

type Pos = [number, number];
const ringClockwise = (ring: Pos[]) => {
  let t = 0;
  for (let i = 0; i < ring.length - 1; i++) t += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return t >= 0;
};
const inRing = (p: Pos, ring: Pos[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export function esriToGeoJsonGeometry(g: any): GeoJsonGeometry | null {
  if (!g || typeof g !== 'object') return null;
  if (Number.isFinite(g.x) && Number.isFinite(g.y)) return { type: 'Point', coordinates: [g.x, g.y] };
  if (Array.isArray(g.points)) return g.points.length ? { type: 'MultiPoint', coordinates: g.points.map((p: number[]) => [p[0], p[1]]) } : null;
  if (Array.isArray(g.paths)) {
    const paths = g.paths.map((p: number[][]) => p.map((c) => [c[0], c[1]])).filter((p: unknown[]) => p.length >= 2);
    if (paths.length === 0) return null;
    return paths.length === 1 ? { type: 'LineString', coordinates: paths[0] } : { type: 'MultiLineString', coordinates: paths };
  }
  if (Array.isArray(g.rings)) {
    const rings: Pos[][] = g.rings.map((r: number[][]) => r.map((c) => [c[0], c[1]] as Pos)).filter((r: Pos[]) => r.length >= 4);
    const polys: Pos[][][] = [];
    const holes: Pos[][] = [];
    for (const r of rings) (ringClockwise(r) ? polys.push([r]) : holes.push(r));
    for (const h of holes) {
      const owner = polys.find((p) => inRing(h[0], p[0]));
      if (owner) owner.push(h);
      else polys.push([h]); // a hole with no outer ring around it: keep it as a polygon rather than lose it
    }
    if (polys.length === 0) return null;
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface FeaturePage {
  features: GeoJsonFeature[];
  /** Total features in the layer when the server reported it. */
  total: number | null;
  /** Features delivered so far, including this page. */
  fetched: number;
  truncated: boolean;
}

/** Number of features in the layer, or null when the server will not say. */
export async function countFeatures(http: HttpClient, layerUrl: string, o: FetchOptions = {}): Promise<number | null> {
  try {
    const j = await getJson(http, `${trimUrl(layerUrl)}/query?${qs({ where: '1=1', returnCountOnly: true, f: 'json' })}`, o);
    return Number.isFinite(j.count) ? Number(j.count) : null;
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    return null;
  }
}

export async function* fetchFeaturePages(http: HttpClient, layerUrl: string, meta: LayerMeta, o: FetchOptions = {}): AsyncGenerator<FeaturePage> {
  const url = `${trimUrl(layerUrl)}/query`;
  const cap = o.maxFeatures ?? 300_000;
  let pageSize = Math.max(1, Math.min(meta.maxRecordCount, o.pageSize ?? 1000)); // never above what the layer allows
  const total = await countFeatures(http, layerUrl, o);
  let format: 'geojson' | 'json' = 'geojson';
  let fetched = 0;

  const base = { outFields: '*', outSR: 4326, returnGeometry: true };
  const oidOrder = meta.objectIdField ? { orderByFields: meta.objectIdField } : {};

  /** One request; falls back to Esri JSON once if the server does not know f=geojson, and halves the page when it is too large. */
  const request = async (extra: Record<string, string | number | boolean | undefined>): Promise<{ features: GeoJsonFeature[]; exceeded: boolean }> => {
    for (;;) {
      try {
        const j = await getJson(http, `${url}?${qs({ ...base, ...extra, f: format })}`, o);
        if (format === 'geojson' && j.type !== 'FeatureCollection') throw Object.assign(new FeatureError('The server did not return GeoJSON.'), { notGeoJson: true });
        if (format === 'geojson') {
          return { features: (j.features ?? []).map((f: any) => ({ geometry: f.geometry ?? null, properties: f.properties ?? {} })), exceeded: j.exceededTransferLimit === true || j.properties?.exceededTransferLimit === true };
        }
        const features: GeoJsonFeature[] = (j.features ?? []).map((f: any) => ({ geometry: esriToGeoJsonGeometry(f.geometry), properties: f.attributes ?? {} }));
        return { features, exceeded: j.exceededTransferLimit === true };
      } catch (e: any) {
        if (format === 'geojson' && (e?.notGeoJson || e?.arcgisCode === 400)) {
          format = 'json';
          continue;
        }
        if (e?.tooLarge && pageSize > 25) {
          pageSize = Math.max(25, Math.floor(pageSize / 2));
          const k = Object.keys(extra);
          if (k.includes('resultRecordCount')) extra = { ...extra, resultRecordCount: pageSize };
          if (k.includes('objectIds')) throw e; // id batches are re-split by the caller
          continue;
        }
        throw e;
      }
    }
  };

  if (meta.supportsPagination) {
    let offset = 0;
    for (;;) {
      if (o.signal?.aborted) throw new AbortedError();
      const want = Math.min(pageSize, cap - fetched);
      const { features, exceeded } = await request({ where: '1=1', ...oidOrder, resultOffset: offset, resultRecordCount: want });
      offset += features.length;
      fetched += features.length;
      const truncated = fetched >= cap && (total === null || fetched < total || exceeded);
      yield { features, total, fetched, truncated };
      const done = features.length === 0 || fetched >= cap || (total !== null ? fetched >= total : !exceeded && features.length < want);
      if (done) return;
    }
  }

  // No pagination: ask for the object ids, then fetch them in batches.
  const idsJson = await getJson(http, `${url}?${qs({ where: '1=1', returnIdsOnly: true, f: 'json' })}`, o);
  const ids: number[] = Array.isArray(idsJson.objectIds) ? idsJson.objectIds : [];
  if (ids.length === 0) {
    yield { features: [], total: 0, fetched: 0, truncated: false };
    return;
  }
  const wanted = ids.slice(0, cap);
  let batch = Math.min(pageSize, 300); // the ids travel in the URL
  for (let i = 0; i < wanted.length; ) {
    if (o.signal?.aborted) throw new AbortedError();
    const chunk = wanted.slice(i, i + batch);
    let features: GeoJsonFeature[];
    try {
      features = (await request({ objectIds: chunk.join(',') })).features;
    } catch (e: any) {
      if (e?.tooLarge && batch > 10) {
        batch = Math.max(10, Math.floor(batch / 2));
        continue;
      }
      throw e;
    }
    i += chunk.length;
    fetched += features.length;
    yield { features, total: ids.length, fetched, truncated: i >= wanted.length && ids.length > wanted.length };
  }
}
