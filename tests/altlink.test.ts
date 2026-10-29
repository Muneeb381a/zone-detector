/** A dead Map URL (404) no longer hides a date that another link in the same row can give. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRows, checkMap, parseCsv, resolveConfig, HttpError } from '@zoning/core';

const table = parseCsv('ID,City,State,TML,Endpoint\n7855,Danville,IL,https://gis.example.gov/viewer/layer/MapServer/0,https://gis.example.gov/dead/MapServer/0');
const mapping = { city: 1, state: 2, county: null, url: 4 };
const config = resolveConfig(JSON.parse(readFileSync('config/config.json', 'utf8')));
const json = (o: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o), url: '', ms: 1 });

describe('dead Map URL, working second link', () => {
  const row = buildRows(table, mapping).rows[0];
  const http = {
    async get(url: string) {
      if (url.includes('/dead/')) return { status: 404, headers: {}, body: 'Not found', url, ms: 1 };
      if (url.includes('/layer/')) return json({ currentVersion: 11, name: 'Zoning', type: 'Feature Layer', fields: [], editingInfo: { lastEditDate: Date.UTC(2025, 5, 4) }, geometryType: 'esriGeometryPolygon', id: 0 });
      throw new HttpError('CONNECTION_FAILED', 'x');
    },
  };
  it('lists the other link on the row', () => expect(row.altUrls?.map((a) => a.column)).toEqual(['TML']));
  it('takes the date from it and still reports the dead link', async () => {
    const r = await checkMap(row, { http: http as any, config });
    expect(r.status).toBe('OK');
    expect(r.primaryDate).toBe('2025-06-04');
    expect(r.sourceUrl).toBe(row.url);
    expect(r.issues.map((i) => i.code)).toContain('DATE_FROM_OTHER_LINK');
    expect(r.issueReason).toMatch(/Not found|404/);
  });
});
