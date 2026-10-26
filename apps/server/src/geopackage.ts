/**
 * GeoPackage (OGC 1.3) writer on node:sqlite. Writes the standard metadata tables, one feature table per layer
 * and geometries in GeoPackage binary (header + little-endian WKB). Everything is WGS 84 (EPSG:4326), 2D.
 * No spatial index is written: QGIS, ArcGIS Pro and GDAL read the file without one.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

export type GpkgGeometryType = 'POINT' | 'MULTIPOINT' | 'MULTILINESTRING' | 'MULTIPOLYGON' | 'GEOMETRY';
export type GpkgColumnType = 'INTEGER' | 'REAL' | 'TEXT' | 'DATETIME';

export interface GpkgColumn {
  /** Name in the source (the key in each feature's properties). */
  source: string;
  type: GpkgColumnType;
}

export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}
export interface GeoJsonFeature {
  type?: 'Feature';
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Geometry encoding
// ---------------------------------------------------------------------------

class Bytes {
  private buf = Buffer.allocUnsafe(256);
  private n = 0;
  private ensure(extra: number) {
    if (this.n + extra <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.n + extra));
    this.buf.copy(next, 0, 0, this.n);
    this.buf = next;
  }
  u8(v: number) { this.ensure(1); this.buf.writeUInt8(v, this.n); this.n += 1; }
  u32(v: number) { this.ensure(4); this.buf.writeUInt32LE(v, this.n); this.n += 4; }
  i32(v: number) { this.ensure(4); this.buf.writeInt32LE(v, this.n); this.n += 4; }
  f64(v: number) { this.ensure(8); this.buf.writeDoubleLE(v, this.n); this.n += 8; }
  bytes(b: Buffer) { this.ensure(b.length); b.copy(this.buf, this.n); this.n += b.length; }
  get length() { return this.n; }
  done(): Buffer { return Buffer.from(this.buf.subarray(0, this.n)); }
}

interface Envelope { minX: number; maxX: number; minY: number; maxY: number }
const emptyEnvelope = (): Envelope => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
const grow = (e: Envelope, x: number, y: number) => {
  if (x < e.minX) e.minX = x;
  if (x > e.maxX) e.maxX = x;
  if (y < e.minY) e.minY = y;
  if (y > e.maxY) e.maxY = y;
};

type Pos = [number, number];
const isPos = (p: unknown): p is number[] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const positions = (v: unknown): Pos[] => (Array.isArray(v) ? v.filter(isPos).map((p) => [p[0], p[1]] as Pos) : []);

function writePoint(w: Bytes, p: Pos, env: Envelope) {
  w.u8(1); w.u32(1); w.f64(p[0]); w.f64(p[1]);
  grow(env, p[0], p[1]);
}
function writeLine(w: Bytes, pts: Pos[], env: Envelope) {
  w.u8(1); w.u32(2); w.u32(pts.length);
  for (const [x, y] of pts) { w.f64(x); w.f64(y); grow(env, x, y); }
}
/** Rings are closed if the source left them open; a ring with fewer than 4 positions is dropped. */
function cleanRings(rings: unknown): Pos[][] {
  if (!Array.isArray(rings)) return [];
  const out: Pos[][] = [];
  for (const r of rings) {
    const pts = positions(r);
    if (pts.length === 0) continue;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]);
    if (pts.length >= 4) out.push(pts);
  }
  return out;
}
function writePolygon(w: Bytes, rings: Pos[][], env: Envelope) {
  w.u8(1); w.u32(3); w.u32(rings.length);
  for (const ring of rings) {
    w.u32(ring.length);
    for (const [x, y] of ring) { w.f64(x); w.f64(y); grow(env, x, y); }
  }
}

/** The declared type each GeoJSON type is promoted to (a layer is declared Multi*, so single parts are wrapped). */
export function declaredTypeOf(esriGeometryType: string | undefined): GpkgGeometryType {
  switch (esriGeometryType) {
    case 'esriGeometryPoint': return 'POINT';
    case 'esriGeometryMultipoint': return 'MULTIPOINT';
    case 'esriGeometryPolyline': return 'MULTILINESTRING';
    case 'esriGeometryPolygon': return 'MULTIPOLYGON';
    default: return 'GEOMETRY';
  }
}

/** WKB for a GeoJSON geometry, promoted to the declared type; null when it is empty or does not fit the declared type. */
export function encodeWkb(g: GeoJsonGeometry | null, declared: GpkgGeometryType): { wkb: Buffer; env: Envelope } | null {
  if (!g || !g.type) return null;
  const w = new Bytes();
  const env = emptyEnvelope();
  const c = g.coordinates;
  const multiOf = (n: number, parts: (() => void)[], code: number) => { w.u8(1); w.u32(code); w.u32(n); parts.forEach((f) => f()); };
  switch (g.type) {
    case 'Point': {
      if (!isPos(c)) return null;
      if (declared === 'MULTIPOINT') multiOf(1, [() => writePoint(w, [c[0], c[1]], env)], 4);
      else if (declared === 'POINT' || declared === 'GEOMETRY') writePoint(w, [c[0], c[1]], env);
      else return null;
      break;
    }
    case 'MultiPoint': {
      const pts = positions(c);
      if (pts.length === 0 || (declared !== 'MULTIPOINT' && declared !== 'GEOMETRY')) return null;
      multiOf(pts.length, pts.map((p) => () => writePoint(w, p, env)), 4);
      break;
    }
    case 'LineString': {
      const pts = positions(c);
      if (pts.length < 2) return null;
      if (declared === 'MULTILINESTRING') multiOf(1, [() => writeLine(w, pts, env)], 5);
      else if (declared === 'GEOMETRY') writeLine(w, pts, env);
      else return null;
      break;
    }
    case 'MultiLineString': {
      const lines = (Array.isArray(c) ? c : []).map(positions).filter((l) => l.length >= 2);
      if (lines.length === 0 || (declared !== 'MULTILINESTRING' && declared !== 'GEOMETRY')) return null;
      multiOf(lines.length, lines.map((l) => () => writeLine(w, l, env)), 5);
      break;
    }
    case 'Polygon': {
      const rings = cleanRings(c);
      if (rings.length === 0) return null;
      if (declared === 'MULTIPOLYGON') multiOf(1, [() => writePolygon(w, rings, env)], 6);
      else if (declared === 'GEOMETRY') writePolygon(w, rings, env);
      else return null;
      break;
    }
    case 'MultiPolygon': {
      const polys = (Array.isArray(c) ? c : []).map(cleanRings).filter((p) => p.length > 0);
      if (polys.length === 0 || (declared !== 'MULTIPOLYGON' && declared !== 'GEOMETRY')) return null;
      multiOf(polys.length, polys.map((p) => () => writePolygon(w, p, env)), 6);
      break;
    }
    default:
      return null; // GeometryCollection and anything else is not supported
  }
  if (!Number.isFinite(env.minX)) return null;
  return { wkb: w.done(), env };
}

/** GeoPackage binary: "GP", version 0, flags (little-endian, XY envelope), SRS id, envelope, then the WKB. */
export function encodeGeometry(g: GeoJsonGeometry | null, declared: GpkgGeometryType, srsId = 4326): { blob: Buffer; env: Envelope } | null {
  const r = encodeWkb(g, declared);
  if (!r) return null;
  const h = new Bytes();
  h.u8(0x47); h.u8(0x50); h.u8(0); h.u8(0b0000_0011);
  h.i32(srsId);
  h.f64(r.env.minX); h.f64(r.env.maxX); h.f64(r.env.minY); h.f64(r.env.maxY);
  h.bytes(r.wkb);
  return { blob: h.done(), env: r.env };
}

// ---------------------------------------------------------------------------
// Names and values
// ---------------------------------------------------------------------------

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** A table or column name that SQLite, QGIS and GDAL all accept: letters, digits and underscores, starting with a letter. */
export function safeName(raw: string, fallback: string, max = 60): string {
  let s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = fallback;
  if (!/^[A-Za-z]/.test(s)) s = `${fallback}_${s}`;
  return s.slice(0, max);
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 56)}_${i}`;
  taken.add(name.toLowerCase());
  return name;
}

function toSqlValue(v: unknown, type: GpkgColumnType): string | number | null {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'INTEGER') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (type === 'REAL') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'DATETIME') {
    // ArcGIS sends dates as epoch milliseconds.
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface GpkgLayerSpec {
  /** Wanted table name; made safe and unique. */
  table: string;
  /** Human title shown by GIS software; made unique. */
  identifier: string;
  description?: string;
  geometryType: GpkgGeometryType;
  columns: GpkgColumn[];
}

export class GpkgLayer {
  readonly table: string;
  readonly identifier: string;
  inserted = 0;
  skipped = 0;
  private env = emptyEnvelope();
  private insertStmt: ReturnType<Db['prepare']>;
  constructor(private db: Db, spec: GpkgLayerSpec, table: string, identifier: string, private cols: { name: string; source: string; type: GpkgColumnType }[]) {
    this.table = table;
    this.identifier = identifier;
    this.geometryType = spec.geometryType;
    const colSql = cols.map((c) => `, ${quote(c.name)} ${c.type}`).join('');
    db.exec(`CREATE TABLE ${quote(table)} (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom ${spec.geometryType}${colSql})`);
    db.prepare('INSERT INTO gpkg_contents (table_name, data_type, identifier, description, srs_id) VALUES (?, ?, ?, ?, 4326)').run(table, 'features', identifier, spec.description ?? '');
    db.prepare('INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, ?, ?, 4326, 0, 0)').run(table, 'geom', spec.geometryType);
    this.insertStmt = db.prepare(`INSERT INTO ${quote(table)} (geom${cols.map((c) => `, ${quote(c.name)}`).join('')}) VALUES (?${cols.map(() => ', ?').join('')})`);
  }
  readonly geometryType: GpkgGeometryType;

  /** Insert one page of features in a single transaction. Features whose geometry is missing or does not fit are counted as skipped. */
  insert(features: GeoJsonFeature[]): void {
    this.db.exec('BEGIN');
    try {
      for (const f of features) {
        const geom = encodeGeometry(f.geometry, this.geometryType);
        if (!geom) {
          this.skipped++;
          continue;
        }
        const props = f.properties ?? {};
        this.insertStmt.run(geom.blob, ...this.cols.map((c) => toSqlValue(props[c.source], c.type)));
        this.inserted++;
        grow(this.env, geom.env.minX, geom.env.minY);
        grow(this.env, geom.env.maxX, geom.env.maxY);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Write the layer's extent into gpkg_contents. */
  finish(): void {
    if (!Number.isFinite(this.env.minX)) return;
    this.db.prepare('UPDATE gpkg_contents SET min_x = ?, min_y = ?, max_x = ?, max_y = ? WHERE table_name = ?').run(this.env.minX, this.env.minY, this.env.maxX, this.env.maxY, this.table);
  }
}

export class GeoPackage {
  private db: Db;
  private tables = new Set<string>(['gpkg_spatial_ref_sys', 'gpkg_contents', 'gpkg_geometry_columns', 'sqlite_sequence']);
  private identifiers = new Set<string>();
  readonly layers: GpkgLayer[] = [];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA application_id = 1196444487;
      PRAGMA user_version = 10300;
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT
      );
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
        CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
      );
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL, m TINYINT NOT NULL,
        CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
        CONSTRAINT uk_gc_table_name UNIQUE (table_name),
        CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
        CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      );
    `);
    const srs = this.db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)');
    srs.run('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined Cartesian coordinate reference system');
    srs.run('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');
    srs.run('WGS 84 geodetic', 4326, 'EPSG', 4326, WGS84_WKT, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid');
  }

  addLayer(spec: GpkgLayerSpec): GpkgLayer {
    const table = uniqueName(safeName(spec.table, 'layer'), this.tables);
    let identifier = spec.identifier || table;
    for (let i = 2; this.identifiers.has(identifier.toLowerCase()); i++) identifier = `${spec.identifier} (${i})`;
    this.identifiers.add(identifier.toLowerCase());

    const used = new Set<string>(['fid', 'geom']);
    const cols = spec.columns.map((c) => {
      const name = uniqueName(safeName(c.source, 'field', 63), used);
      return { name, source: c.source, type: c.type };
    });
    const layer = new GpkgLayer(this.db, spec, table, identifier, cols);
    this.layers.push(layer);
    return layer;
  }

  /** Remove a layer that produced no features. */
  dropLayer(layer: GpkgLayer): void {
    this.db.exec(`DROP TABLE ${quote(layer.table)}`);
    this.db.prepare('DELETE FROM gpkg_geometry_columns WHERE table_name = ?').run(layer.table);
    this.db.prepare('DELETE FROM gpkg_contents WHERE table_name = ?').run(layer.table);
    this.identifiers.delete(layer.identifier.toLowerCase());
    this.layers.splice(this.layers.indexOf(layer), 1);
  }

  close(): void {
    for (const l of this.layers) l.finish();
    this.db.close();
  }
}
