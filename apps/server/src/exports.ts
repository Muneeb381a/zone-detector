/**
 * GeoPackage export: planning which layers of each map can be downloaded, and the background job that
 * downloads them into one .gpkg file (several maps and layers go into the same file, one table each).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbortedError, isPdfUrl, normalizeUrl, zoningScore, type Config, type HttpClient } from '@zoning/core';
import { columnsFor, fetchFeaturePages, FeatureError, readLayerMeta, readServiceLayers, type LayerMeta } from './arcgis-features';
import { declaredTypeOf, GeoPackage, safeName } from './geopackage';

export interface ExportItem {
  rowId?: string;
  city: string;
  state?: string;
  /** The service (or layer) link: the checked map's normalized URL. */
  url: string;
  /** Layers to download. Omitted = the layers that look like zoning, as in the plan. */
  layerIds?: number[];
}

export interface PlannedLayer {
  id: number;
  name: string;
  geometryType: string | null;
  /** Can be downloaded: it has geometry and the service allows queries. */
  exportable: boolean;
  zoning: boolean;
  selected: boolean;
  note?: string;
}

export interface PlannedMap {
  rowId?: string;
  city: string;
  state: string;
  url: string;
  layers: PlannedLayer[];
  error?: string;
}

export const MAX_MAPS_PER_EXPORT = 50;
const MAX_LAYERS_LISTED = 40;
const MAX_LAYERS_PER_MAP = 12;

const GEOMETRY_LABEL: Record<string, string> = {
  esriGeometryPoint: 'points',
  esriGeometryMultipoint: 'points',
  esriGeometryPolyline: 'lines',
  esriGeometryPolygon: 'polygons',
};
export const geometryLabel = (t: string | undefined) => (t ? GEOMETRY_LABEL[t] ?? t.replace('esriGeometry', '').toLowerCase() : 'no geometry');

type ServiceTarget = { ok: true; serviceUrl: string; layerId?: number } | { ok: false; error: string };

function serviceTarget(url: string): ServiceTarget {
  if (isPdfUrl(url)) return { ok: false, error: 'This map is a PDF file, not an ArcGIS service, so there is no map data to put in a GeoPackage. Open the PDF to save it.' };
  const n = normalizeUrl(url);
  if (!n.ok) return { ok: false, error: n.reason };
  if (n.kind === 'MapServer' || n.kind === 'FeatureServer') return { ok: true, serviceUrl: n.serviceUrl, layerId: n.layerId };
  if (n.kind === 'ImageServer') return { ok: false, error: 'This is an image service: it holds a raster, not features, so there is nothing to put in a GeoPackage.' };
  if (n.kind === 'AppUrl') return { ok: false, error: 'This is a viewer link. Re-check the map first, so the service behind it is known.' };
  return { ok: false, error: 'This link is not a map service (…/MapServer or …/FeatureServer).' };
}

const layerOf = (meta: LayerMeta, zoning: boolean): PlannedLayer => {
  const exportable = !!meta.geometryType && meta.queryable && meta.type !== 'Table' && meta.type !== 'Raster Layer';
  return {
    id: meta.id,
    name: meta.name,
    geometryType: meta.geometryType ?? null,
    exportable,
    zoning,
    selected: false,
    note: !meta.geometryType ? 'no geometry' : !meta.queryable ? 'queries are turned off on this layer' : undefined,
  };
};

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Which layers each map has, and which of them look like the zoning layer (those start selected). */
export async function planExport(items: ExportItem[], http: HttpClient, config: Config, signal?: AbortSignal): Promise<PlannedMap[]> {
  return mapPool(items, 3, async (item): Promise<PlannedMap> => {
    const base = { rowId: item.rowId, city: item.city, state: item.state ?? '', url: item.url, layers: [] as PlannedLayer[] };
    const target = serviceTarget(item.url);
    if (!target.ok) return { ...base, error: target.error };
    try {
      let metas: LayerMeta[];
      if (target.layerId !== undefined) {
        metas = [await readLayerMeta(http, `${target.serviceUrl}/${target.layerId}`, { signal })];
      } else {
        const listed = (await readServiceLayers(http, target.serviceUrl, { signal })).filter((l) => !l.group).slice(0, MAX_LAYERS_LISTED);
        const got = await mapPool(listed, 4, async (l) => {
          try {
            return await readLayerMeta(http, `${target.serviceUrl}/${l.id}`, { signal });
          } catch (e) {
            if (e instanceof AbortedError) throw e;
            return null;
          }
        });
        metas = got.filter((m): m is LayerMeta => m !== null);
      }
      const layers = metas.map((m) => layerOf(m, zoningScore(m.name, config.layerKeywords) > 0));
      const exportable = layers.filter((l) => l.exportable);
      const zoning = exportable.filter((l) => l.zoning);
      // Zoning-like layers; otherwise everything when there are only a few; otherwise the analyst chooses.
      const pick = zoning.length > 0 ? zoning : exportable.length <= 3 ? exportable : [];
      for (const l of pick.slice(0, MAX_LAYERS_PER_MAP)) l.selected = true;
      if (layers.length === 0) return { ...base, error: 'The service lists no layers.' };
      return { ...base, layers };
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ---------------------------------------------------------------------------
// The export job
// ---------------------------------------------------------------------------

export interface ExportLayerReport {
  map: string;
  layer: string;
  table?: string;
  features: number;
  skipped: number;
  truncated: boolean;
  error?: string;
}

export interface ExportProgress {
  layersTotal: number;
  layersDone: number;
  features: number;
  /** Features in the layer being downloaded, when the server said. */
  layerTotal: number | null;
  layerFeatures: number;
  current: string;
}

export type ExportState = 'running' | 'done' | 'error' | 'cancelled';

export class ExportJob {
  readonly id = randomUUID();
  state: ExportState = 'running';
  error = '';
  readonly progress: ExportProgress = { layersTotal: 0, layersDone: 0, features: 0, layerTotal: null, layerFeatures: 0, current: 'Starting…' };
  readonly layers: ExportLayerReport[] = [];
  readonly createdAt = Date.now();
  readonly controller = new AbortController();
  filename = '';
  path = '';
  bytes = 0;
  finished?: Promise<void>;

  cancel() {
    if (this.state === 'running') this.controller.abort();
  }
  get summary() {
    return { id: this.id, state: this.state, error: this.error, progress: this.progress, layers: this.layers, filename: this.filename, bytes: this.bytes };
  }
}

export interface ExportOptions {
  items: ExportItem[];
  http: HttpClient;
  config: Config;
  dir: string;
  maxFeatures?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function exportDir(): string {
  return process.env.EXPORT_DIR ?? join(tmpdir(), 'zoning-exports');
}

const dateStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const label = (it: ExportItem) => (it.state ? `${it.city}, ${it.state}` : it.city);

async function run(job: ExportJob, o: ExportOptions): Promise<void> {
  const { items, http, config } = o;
  const signal = job.controller.signal;
  job.filename = items.length === 1 ? `${safeName(`${items[0].city}_${items[0].state ?? ''}`, 'map')}_${dateStamp()}.gpkg` : `zoning-maps-${items.length}_${dateStamp()}.gpkg`;
  mkdirSync(o.dir, { recursive: true });
  job.path = join(o.dir, `${job.id}.gpkg`);
  const gpkg = new GeoPackage(job.path);
  try {
    // Work out the layers first, so the progress bar has a total.
    const work: { item: ExportItem; serviceUrl: string; layerId: number }[] = [];
    const planned = items.some((i) => !i.layerIds) ? await planExport(items.filter((i) => !i.layerIds), http, config, signal) : [];
    const byKey = new Map(planned.map((p) => [`${p.rowId ?? ''}|${p.url}`, p]));
    for (const item of items) {
      const target = serviceTarget(item.url);
      if (!target.ok) {
        job.layers.push({ map: label(item), layer: '', features: 0, skipped: 0, truncated: false, error: target.error });
        continue;
      }
      let ids = item.layerIds;
      if (!ids) {
        const p = byKey.get(`${item.rowId ?? ''}|${item.url}`);
        ids = p?.layers.filter((l) => l.selected).map((l) => l.id) ?? [];
        if (p?.error) job.layers.push({ map: label(item), layer: '', features: 0, skipped: 0, truncated: false, error: p.error });
        else if (ids.length === 0) job.layers.push({ map: label(item), layer: '', features: 0, skipped: 0, truncated: false, error: 'No layer looks like a zoning layer. Choose the layers to download.' });
      }
      for (const layerId of ids.slice(0, MAX_LAYERS_PER_MAP)) work.push({ item, serviceUrl: target.serviceUrl, layerId: target.layerId ?? layerId });
    }
    job.progress.layersTotal = work.length;

    for (const { item, serviceUrl, layerId } of work) {
      if (signal.aborted) throw new AbortedError();
      const layerUrl = `${serviceUrl}/${layerId}`;
      const report: ExportLayerReport = { map: label(item), layer: `Layer ${layerId}`, features: 0, skipped: 0, truncated: false };
      job.layers.push(report);
      job.progress.current = `${report.map} · layer ${layerId}`;
      job.progress.layerFeatures = 0;
      job.progress.layerTotal = null;
      try {
        const meta = await readLayerMeta(http, layerUrl, { signal });
        report.layer = meta.name;
        job.progress.current = `${report.map} · ${meta.name}`;
        if (!meta.geometryType || meta.type === 'Table') throw new FeatureError('This layer has no geometry (it is a table).');
        if (!meta.queryable) throw new FeatureError('Queries are turned off on this layer.');
        const layer = gpkg.addLayer({
          table: `${item.city}_${item.state ?? ''}_${meta.name}`,
          identifier: `${label(item)} – ${meta.name}`,
          description: `Source: ${layerUrl}`,
          geometryType: declaredTypeOf(meta.geometryType),
          columns: columnsFor(meta),
        });
        report.table = layer.table;
        try {
          for await (const page of fetchFeaturePages(http, layerUrl, meta, { signal, maxFeatures: o.maxFeatures, sleep: o.sleep })) {
            layer.insert(page.features);
            job.progress.features += page.features.length;
            job.progress.layerFeatures = page.fetched;
            job.progress.layerTotal = page.total;
            report.truncated ||= page.truncated;
          }
        } finally {
          report.features = layer.inserted;
          report.skipped = layer.skipped;
        }
        if (layer.inserted === 0) {
          gpkg.dropLayer(layer);
          report.table = undefined;
          report.error = 'The layer has no features.';
        }
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        report.error = e instanceof Error ? e.message : String(e);
        const failed = gpkg.layers.find((l) => l.table === report.table);
        if (failed && failed.inserted === 0) {
          gpkg.dropLayer(failed);
          report.table = undefined;
        }
      }
      job.progress.layersDone++;
    }

    gpkg.close();
    const written = job.layers.filter((l) => l.table).length;
    if (written === 0) {
      job.state = 'error';
      job.error = job.layers.find((l) => l.error)?.error ?? 'Nothing could be downloaded.';
      rmSync(job.path, { force: true });
      return;
    }
    job.bytes = statSync(job.path).size;
    job.progress.current = 'Done';
    job.state = 'done';
  } catch (e) {
    try { gpkg.close(); } catch { /* already closed */ }
    rmSync(job.path, { force: true });
    if (e instanceof AbortedError || signal.aborted) job.state = 'cancelled';
    else {
      job.state = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    }
  }
}

/** Keeps finished files for a while so the browser can fetch them, then removes them. */
export class ExportRegistry {
  private jobs = new Map<string, ExportJob>();
  constructor(private ttlMs = 30 * 60_000, private maxRunning = 2) {}

  create(o: ExportOptions): ExportJob | null {
    if ([...this.jobs.values()].filter((j) => j.state === 'running').length >= this.maxRunning) return null;
    const job = new ExportJob();
    this.jobs.set(job.id, job);
    job.finished = run(job, o).finally(() => {
      const t = setTimeout(() => this.remove(job.id), this.ttlMs);
      t.unref?.();
    });
    return job;
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  remove(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.cancel();
    if (j.path) rmSync(j.path, { force: true });
    this.jobs.delete(id);
  }
  /** Tests and shutdown. */
  async closeAll() {
    for (const j of this.jobs.values()) j.cancel();
    await Promise.all([...this.jobs.values()].map((j) => j.finished));
    for (const id of [...this.jobs.keys()]) this.remove(id);
  }
}
