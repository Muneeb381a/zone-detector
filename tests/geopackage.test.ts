/** GeoPackage export: the file writer, downloading features from ArcGIS (three kinds of server), and the HTTP API. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/server/src/app';
import { esriToGeoJsonGeometry, fetchFeaturePages, readLayerMeta } from '../apps/server/src/arcgis-features';
import { encodeGeometry, GeoPackage, safeName } from '../apps/server/src/geopackage';
import { MockHttp, reply } from './helpers';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const open = (path: string) => new DatabaseSync(path, { readOnly: true });

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gpkg-test-'));
  process.env.EXPORT_DIR = join(dir, 'exports');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const square = (x: number, y: number, s = 1) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];

describe('GeoPackage writer', () => {
  it('writes the standard tables, the layer, its geometry and attributes', () => {
    const path = join(dir, 'a.gpkg');
    const g = new GeoPackage(path);
    const layer = g.addLayer({
      table: 'Testville, TX – Zoning Districts',
      identifier: 'Testville, TX – Zoning Districts',
      description: 'Source: https://x/MapServer/0',
      geometryType: 'MULTIPOLYGON',
      columns: [{ source: 'ZONE', type: 'TEXT' }, { source: 'EDITED', type: 'DATETIME' }, { source: 'ACRES', type: 'REAL' }, { source: 'fid', type: 'INTEGER' }, { source: 'zone', type: 'TEXT' }],
    });
    layer.insert([
      { geometry: { type: 'Polygon', coordinates: square(10, 20) }, properties: { ZONE: 'R-1', EDITED: Date.UTC(2023, 5, 5), ACRES: 12.5, fid: 7, zone: 'dup' } },
      { geometry: { type: 'MultiPolygon', coordinates: [square(0, 0), square(5, 5, 2)] }, properties: { ZONE: 'C-2', EDITED: null, ACRES: '3.25' } },
      { geometry: null, properties: { ZONE: 'no geometry' } },
      { geometry: { type: 'Point', coordinates: [1, 1] }, properties: { ZONE: 'wrong kind' } },
    ]);
    expect([layer.inserted, layer.skipped]).toEqual([2, 2]);
    g.close();

    const db = open(path);
    const one = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    expect(one('PRAGMA application_id').application_id).toBe(0x47504b47);
    expect(one('PRAGMA user_version').user_version).toBe(10300);
    expect(one('PRAGMA integrity_check').integrity_check).toBe('ok');
    expect((db.prepare('SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id').all() as any[]).map((r) => r.srs_id)).toEqual([-1, 0, 4326]);

    const c = one('SELECT * FROM gpkg_contents');
    expect(c).toMatchObject({ table_name: 'Testville_TX_Zoning_Districts', data_type: 'features', identifier: 'Testville, TX – Zoning Districts', srs_id: 4326, min_x: 0, min_y: 0, max_x: 11, max_y: 21 });
    expect(one('SELECT * FROM gpkg_geometry_columns')).toMatchObject({ table_name: 'Testville_TX_Zoning_Districts', column_name: 'geom', geometry_type_name: 'MULTIPOLYGON', srs_id: 4326, z: 0, m: 0 });

    // Column names are made safe and unique; "fid" and "geom" stay the key and geometry.
    const cols = (db.prepare('PRAGMA table_info(Testville_TX_Zoning_Districts)').all() as any[]).map((r) => r.name);
    expect(cols).toEqual(['fid', 'geom', 'ZONE', 'EDITED', 'ACRES', 'fid_2', 'zone_2']);
    const rows = db.prepare('SELECT * FROM Testville_TX_Zoning_Districts ORDER BY fid').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ZONE: 'R-1', EDITED: '2023-06-05T00:00:00.000Z', ACRES: 12.5, fid_2: 7, zone_2: 'dup' });
    expect(rows[1]).toMatchObject({ ZONE: 'C-2', EDITED: null, ACRES: 3.25 });

    // GeoPackage binary header, then WKB (little endian MultiPolygon with one Polygon).
    const b = Buffer.from(rows[0].geom);
    expect(b.subarray(0, 4)).toEqual(Buffer.from([0x47, 0x50, 0, 0x03]));
    expect(b.readInt32LE(4)).toBe(4326);
    expect([b.readDoubleLE(8), b.readDoubleLE(16), b.readDoubleLE(24), b.readDoubleLE(32)]).toEqual([10, 11, 20, 21]);
    expect(b.readUInt8(40)).toBe(1); // little endian
    expect(b.readUInt32LE(41)).toBe(6); // MultiPolygon
    expect(b.readUInt32LE(45)).toBe(1); // one polygon
    expect(b.readUInt32LE(50)).toBe(3); // Polygon
    expect(b.readUInt32LE(54)).toBe(1); // one ring
    expect(b.readUInt32LE(58)).toBe(5); // five positions
    expect([b.readDoubleLE(62), b.readDoubleLE(70)]).toEqual([10, 20]);
    db.close();
  });

  it('closes open rings, drops degenerate geometry, and keeps points and lines', () => {
    expect(encodeGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, 'MULTIPOLYGON')!.blob.readUInt32LE(58)).toBe(5); // ring closed
    expect(encodeGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, 'MULTIPOLYGON')).toBeNull();
    expect(encodeGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 'MULTILINESTRING')!.env).toMatchObject({ minX: 0, maxX: 1 });
    expect(encodeGeometry({ type: 'Point', coordinates: [3, 4] }, 'POINT')!.blob.length).toBe(40 + 21);
    expect(encodeGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 'POINT')).toBeNull();
    expect(encodeGeometry({ type: 'Point', coordinates: [NaN, 4] }, 'POINT')).toBeNull();
  });

  it('makes names safe and unique, and drops a layer that stayed empty', () => {
    expect(safeName('Zoning – Districts (2023)!', 'x')).toBe('Zoning_Districts_2023');
    expect(safeName('123 Main', 'layer')).toBe('layer_123_Main');
    expect(safeName('é!!', 'f')).toBe('e');
    const path = join(dir, 'b.gpkg');
    const g = new GeoPackage(path);
    const spec = { table: 'Same Name', identifier: 'Same', geometryType: 'POINT' as const, columns: [] };
    const l1 = g.addLayer(spec);
    const l2 = g.addLayer(spec);
    expect([l1.table, l2.table]).toEqual(['Same_Name', 'Same_Name_2']);
    expect(l2.identifier).toBe('Same (2)');
    l1.insert([{ geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} }]);
    g.dropLayer(l2);
    g.close();
    const db = open(path);
    expect((db.prepare('SELECT table_name FROM gpkg_contents').all() as any[]).map((r) => r.table_name)).toEqual(['Same_Name']);
    expect((db.prepare('SELECT table_name FROM gpkg_geometry_columns').all() as any[]).map((r) => r.table_name)).toEqual(['Same_Name']);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// A pretend ArcGIS server
// ---------------------------------------------------------------------------

const SVC = 'https://gis.testville.gov/arcgis/rest/services/Planning/Zoning/MapServer';
const fields = [
  { name: 'OBJECTID', type: 'esriFieldTypeOID' },
  { name: 'ZONE', type: 'esriFieldTypeString' },
  { name: 'EDITED', type: 'esriFieldTypeDate' },
  { name: 'Shape', type: 'esriFieldTypeGeometry' },
];
const FEATURES = [0, 1, 2, 3, 4].map((i) => ({ id: i + 1, zone: `Z${i}`, coords: square(i * 2, 0) }));
const asGeoJson = (list: typeof FEATURES) => list.map((f) => ({ type: 'Feature', id: f.id, geometry: { type: 'Polygon', coordinates: f.coords }, properties: { OBJECTID: f.id, ZONE: f.zone, EDITED: 1700000000000 + f.id } }));
const asEsri = (list: typeof FEATURES) => list.map((f) => ({ attributes: { OBJECTID: f.id, ZONE: f.zone, EDITED: 1700000000000 + f.id }, geometry: { rings: f.coords.map((r) => [...r].reverse()) } })); // Esri outer rings run clockwise

type Kind = 'paged' | 'legacy' | 'ids';
const layerMeta = (kind: Kind, over: object = {}) => ({
  name: 'Zoning Districts', type: 'Feature Layer', geometryType: 'esriGeometryPolygon', capabilities: 'Map,Query,Data', maxRecordCount: 2, objectIdField: 'OBJECTID', fields,
  advancedQueryCapabilities: { supportsPagination: kind !== 'ids' }, ...over,
});

function server(kind: Kind) {
  const q = (url: string) => new URL(url).searchParams;
  return new MockHttp([
    [/\/MapServer\?f=json/, () => reply({ layers: [{ id: 0, name: 'Zoning Districts' }, { id: 1, name: 'Roads' }, { id: 2, name: 'Notes table' }, { id: 3, name: 'Group', subLayerIds: [0] }] })],
    [/\/MapServer\/0\?f=json/, () => reply(layerMeta(kind))],
    [/\/MapServer\/1\?f=json/, () => reply(layerMeta('paged', { name: 'Roads', geometryType: 'esriGeometryPolyline' }))],
    [/\/MapServer\/2\?f=json/, () => reply(layerMeta('paged', { name: 'Notes table', type: 'Table', geometryType: undefined }))],
    [/\/MapServer\/0\/query/, (url) => {
      const p = q(url);
      if (p.get('returnCountOnly')) return reply({ count: FEATURES.length });
      if (p.get('returnIdsOnly')) return reply({ objectIdFieldName: 'OBJECTID', objectIds: FEATURES.map((f) => f.id) });
      if (kind === 'legacy' && p.get('f') === 'geojson') return reply({ error: { code: 400, message: 'Invalid or missing input parameters.', details: ['Invalid format: geojson'] } });
      let list = FEATURES;
      const ids = p.get('objectIds');
      if (ids) list = FEATURES.filter((f) => ids.split(',').map(Number).includes(f.id));
      const off = Number(p.get('resultOffset') ?? 0);
      const n = Number(p.get('resultRecordCount') ?? 1000);
      const page = ids ? list : list.slice(off, off + n);
      const exceeded = !ids && off + n < FEATURES.length;
      return p.get('f') === 'geojson'
        ? reply({ type: 'FeatureCollection', features: asGeoJson(page), ...(exceeded ? { exceededTransferLimit: true } : {}) })
        : reply({ features: asEsri(page), ...(exceeded ? { exceededTransferLimit: true } : {}) });
    }],
  ]);
}

const collect = async (kind: Kind, over: { maxFeatures?: number } = {}) => {
  const http = server(kind);
  const meta = await readLayerMeta(http, `${SVC}/0`);
  const pages = [];
  for await (const p of fetchFeaturePages(http, `${SVC}/0`, meta, over)) pages.push(p);
  return { http, meta, pages, features: pages.flatMap((p) => p.features) };
};

describe('downloading features from ArcGIS', () => {
  it('reads the layer description', async () => {
    const meta = await readLayerMeta(server('paged'), `${SVC}/0`);
    expect(meta).toMatchObject({ id: 0, name: 'Zoning Districts', geometryType: 'esriGeometryPolygon', maxRecordCount: 2, objectIdField: 'OBJECTID', supportsPagination: true, queryable: true });
  });

  it('pages through a layer that supports pagination (GeoJSON)', async () => {
    const { pages, features } = await collect('paged');
    expect(pages.map((p) => p.features.length)).toEqual([2, 2, 1]);
    expect(features.map((f) => f.properties!.ZONE)).toEqual(['Z0', 'Z1', 'Z2', 'Z3', 'Z4']);
    expect(pages.at(-1)).toMatchObject({ total: 5, fetched: 5, truncated: false });
  });

  it('falls back to Esri JSON when the server cannot answer f=geojson, and converts the geometry', async () => {
    const { features } = await collect('legacy');
    expect(features).toHaveLength(5);
    expect(features[1].geometry).toEqual({ type: 'Polygon', coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]].reverse()] });
  });

  it('fetches object ids in batches when pagination is not supported', async () => {
    const { http, features } = await collect('ids');
    expect(features).toHaveLength(5);
    expect(http.calls.some((u) => u.includes('returnIdsOnly=true'))).toBe(true);
    expect(http.calls.some((u) => u.includes('resultOffset'))).toBe(false);
  });

  it('stops at the feature limit and says it was cut short', async () => {
    const { features, pages } = await collect('paged', { maxFeatures: 3 });
    expect(features).toHaveLength(3);
    expect(pages.at(-1)!.truncated).toBe(true);
  });

  it('turns Esri rings into polygons with holes, and groups several outer rings', () => {
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]; // clockwise
    const hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]; // counter-clockwise
    const other = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]];
    expect(esriToGeoJsonGeometry({ rings: [outer, hole] })).toEqual({ type: 'Polygon', coordinates: [outer, hole] });
    expect(esriToGeoJsonGeometry({ rings: [outer, other, hole] })).toEqual({ type: 'MultiPolygon', coordinates: [[outer, hole], [other]] });
    expect(esriToGeoJsonGeometry({ paths: [[[0, 0], [1, 1]]] })).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    expect(esriToGeoJsonGeometry({ x: 1, y: 2 })).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(esriToGeoJsonGeometry({})).toBeNull();
  });

  it('reports a secured layer plainly', async () => {
    const http = new MockHttp([[/./, () => reply({ error: { code: 499, message: 'Token Required' } })]]);
    await expect(readLayerMeta(http, `${SVC}/0`)).rejects.toThrow(/requires a token/);
  });
});

// ---------------------------------------------------------------------------
// The HTTP API
// ---------------------------------------------------------------------------

describe('GeoPackage API', () => {
  const makeApp = (kind: Kind = 'paged') => buildApp({ dbPath: ':memory:', http: server(kind) });
  const waitDone = async (app: ReturnType<typeof buildApp>, id: string) => {
    for (let i = 0; i < 200; i++) {
      const s = (await app.inject({ method: 'GET', url: `/api/exports/${id}` })).json();
      if (s.state !== 'running') return s;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('export did not finish');
  };

  it('plans the layers: zoning layers start selected, tables and groups are not offered', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/exports/plan', payload: { items: [{ rowId: '2', city: 'Testville', state: 'TX', url: SVC }] } });
    const [m] = res.json().maps;
    expect(m.error).toBeUndefined();
    expect(m.layers.map((l: any) => [l.id, l.name, l.exportable, l.selected])).toEqual([[0, 'Zoning Districts', true, true], [1, 'Roads', true, false], [2, 'Notes table', false, false]]);
    await app.close();
  });

  it('explains a link that is not a map service', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/exports/plan', payload: { items: [{ city: 'A', url: 'https://city.maps.arcgis.com/apps/instant/index.html?appid=0123456789abcdef0123456789abcdef' }, { city: 'B', url: 'https://x.gov/img/ImageServer' }, { city: 'C', url: '' }] } });
    expect(res.statusCode).toBe(400); // empty url is rejected up front
    const ok = await app.inject({ method: 'POST', url: '/api/exports/plan', payload: { items: [{ city: 'A', url: 'https://city.maps.arcgis.com/apps/instant/index.html?appid=0123456789abcdef0123456789abcdef' }, { city: 'B', url: 'https://x.gov/img/ImageServer' }] } });
    expect(ok.json().maps.map((m: any) => m.error)).toEqual([expect.stringMatching(/viewer link/), expect.stringMatching(/image service/)]);
    await app.close();
  });

  for (const kind of ['paged', 'legacy', 'ids'] as const) {
    it(`downloads a map into a GeoPackage file (${kind} server)`, async () => {
      const app = makeApp(kind);
      const start = await app.inject({ method: 'POST', url: '/api/exports', payload: { items: [{ rowId: '2', city: 'Testville', state: 'TX', url: SVC, layerIds: [0] }] } });
      expect(start.statusCode).toBe(202);
      const id = start.json().id;
      const done = await waitDone(app, id);
      expect(done).toMatchObject({ state: 'done', progress: { layersTotal: 1, layersDone: 1, features: 5 } });
      expect(done.layers).toEqual([expect.objectContaining({ map: 'Testville, TX', layer: 'Zoning Districts', features: 5, truncated: false })]);

      const file = await app.inject({ method: 'GET', url: `/api/exports/${id}/file` });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toMatch(/Testville_TX_\d{8}\.gpkg/);
      expect(file.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
      const path = join(dir, `${kind}.gpkg`);
      (await import('node:fs')).writeFileSync(path, file.rawPayload);
      const db = open(path);
      expect(db.prepare('SELECT count(*) AS n FROM Testville_TX_Zoning_Districts').get()).toMatchObject({ n: 5 });
      expect(db.prepare('SELECT ZONE, EDITED FROM Testville_TX_Zoning_Districts ORDER BY fid LIMIT 1').get()).toMatchObject({ ZONE: 'Z0', EDITED: '2023-11-14T22:13:20.001Z' });
      expect((db.prepare('PRAGMA table_info(Testville_TX_Zoning_Districts)').all() as any[]).map((r) => r.name)).toEqual(['fid', 'geom', 'OBJECTID', 'ZONE', 'EDITED']);
      db.close();
      await app.close();
    });
  }

  it('puts several maps and layers into one file, and keeps going when one layer fails', async () => {
    const app = makeApp();
    const start = await app.inject({
      method: 'POST',
      url: '/api/exports',
      payload: { items: [{ city: 'Testville', state: 'TX', url: SVC }, { city: 'Other Town', state: 'OK', url: SVC, layerIds: [0, 1, 2] }] },
    });
    const id = start.json().id;
    const done = await waitDone(app, id);
    expect(done.state).toBe('done');
    expect(done.filename).toMatch(/^zoning-maps-2_\d{8}\.gpkg$/);
    const byMap = (m: string) => done.layers.filter((l: any) => l.map === m);
    expect(byMap('Testville, TX').map((l: any) => l.table)).toEqual(['Testville_TX_Zoning_Districts']); // the planned (zoning) layer only
    expect(byMap('Other Town, OK').map((l: any) => [l.layer, l.table ?? null, l.error ? true : false])).toEqual([
      ['Zoning Districts', 'Other_Town_OK_Zoning_Districts', false],
      ['Roads', null, true], // this pretend server has no features for Roads
      ['Notes table', null, true], // a table has no geometry
    ]);
    const file = await app.inject({ method: 'GET', url: `/api/exports/${id}/file` });
    const path = join(dir, 'multi.gpkg');
    (await import('node:fs')).writeFileSync(path, file.rawPayload);
    const db = open(path);
    expect((db.prepare('SELECT table_name FROM gpkg_contents ORDER BY table_name').all() as any[]).map((r) => r.table_name)).toEqual(['Other_Town_OK_Zoning_Districts', 'Testville_TX_Zoning_Districts']);
    db.close();
    await app.close();
  });

  it('reports an error, and offers no file, when nothing could be downloaded', async () => {
    const app = buildApp({ dbPath: ':memory:', http: new MockHttp([[/./, () => reply({ error: { code: 499, message: 'Token Required' } })]]) });
    const id = (await app.inject({ method: 'POST', url: '/api/exports', payload: { items: [{ city: 'Locked', url: `${SVC}/0` }] } })).json().id;
    const done = await waitDone(app, id);
    expect(done.state).toBe('error');
    expect(done.error).toMatch(/token/i);
    expect((await app.inject({ method: 'GET', url: `/api/exports/${id}/file` })).statusCode).toBe(404);
    await app.close();
  });

  it('rejects an empty request and an unknown download', async () => {
    const app = makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/exports', payload: { items: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/exports/nope' })).statusCode).toBe(404);
    await app.close();
  });
});

void readFileSync;
