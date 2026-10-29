/** The sheet's own City ID: found from many header shapes, carried on every row, and used by Review & copy. */
import { describe, expect, it } from 'vitest';
import { buildCopyTable, buildRows, findIdColumn, parseCsv, suggestMapping } from '@zoning/core';

const csv = (text: string) => parseCsv(text.trim());
const MAPPED = { city: 1, state: 2, county: null, url: 3 };

describe('findIdColumn', () => {
  it('reads the analyst sheet’s decorated header "100 - IDs"', () => {
    const t = csv('100 - IDs,100 - Cities,20 - States,100 - Endpoint_Links\n3217,Opelika,AL,https://a.gov/x/MapServer');
    expect(findIdColumn(t, suggestMapping(t[0], t.slice(1)))).toBe(0);
  });
  it('knows the usual names, with a count in front or behind', () => {
    for (const h of ['City ID', 'ID', 'IDs', 'CityID', 'Map_ID', 'Municipality ID', 'ID (100)', '12 - City IDs']) {
      const t = csv(`Notes,${h},City,State,URL\nx,7,Opelika,AL,https://a.gov`);
      expect(findIdColumn(t, { city: 2, state: 3, county: null, url: 4 }), h).toBe(1);
    }
  });
  it('finds an ID that sits to the right of the city, not only on its left', () => {
    const t = csv('City,State,Map URL,City ID\nOpelika,AL,https://a.gov,3217');
    expect(findIdColumn(t, { city: 0, state: 1, county: null, url: 2 })).toBe(3);
  });
  it('does not take words that merely end in "id"', () => {
    const t = csv('City,State,URL,valid,grid\nOpelika,AL,https://a.gov,1,2');
    expect(findIdColumn(t, { city: 0, state: 1, county: null, url: 2 })).toBe(-1);
  });
  it('falls back to the column left of City when it holds different short values, but not when it is a name or repeats', () => {
    expect(findIdColumn(csv('#,City,State,URL\n1,A,AL,u\n2,B,AL,u\n3,C,AL,u'), MAPPED)).toBe(0);
    expect(findIdColumn(csv('Region,City,State,URL\nSouth,A,AL,u\nSouth,B,AL,u\nSouth,C,AL,u'), MAPPED)).toBe(-1);
  });
  it('a chosen column wins, and null switches it off', () => {
    const t = csv('City ID,City,State,URL,Other\n1,A,AL,u,99');
    expect(findIdColumn(t, { ...MAPPED, id: 4 })).toBe(4);
    expect(findIdColumn(t, { ...MAPPED, id: null })).toBe(-1);
  });
});

describe('the ID on each row and in Review & copy', () => {
  const t = csv('100 - IDs,100 - Cities,20 - States,100 - Endpoint_Links\n3217,Opelika,AL,https://a.gov/x/MapServer\n,Bentonville,AR,https://b.gov/x/MapServer');
  const mapping = { city: 1, state: 2, county: null, url: 3 };

  it('carries the sheet ID on the row as written (and only when there is one)', () => {
    const rows = buildRows(t, mapping).rows;
    expect(rows[0].cityId).toBe('3217');
    expect(rows[1].cityId).toBeUndefined();
  });
  it('Review & copy uses the same column, and leaves a blank ID blank', () => {
    const out = buildCopyTable(t, buildRows(t, mapping).rows, {}, mapping);
    expect(out[1][0]).toBe('3217');
    expect(out[2][0]).toBe('');
  });
  it('an ID column that is not next to the city is still found by Review & copy', () => {
    const t2 = csv('City,State,URL,Notes,City ID\nOpelika,AL,https://a.gov/x/MapServer,n,3217');
    const m2 = { city: 0, state: 1, county: null, url: 2 };
    expect(buildCopyTable(t2, buildRows(t2, m2).rows, {}, m2)[1][0]).toBe('3217');
  });
});

describe('rows saved by an earlier version', () => {
  const t = csv('100 - IDs,100 - Cities,20 - States,100 - Endpoint_Links,Type PDF: 1 | AG: 1\n3217,Opelika,AL,https://a.gov/x/MapServer,ArcGIS\n88,Yakima,WA,https://b.gov/x/MapServer,PDF');
  const mapping = { city: 1, state: 2, county: null, url: 3 };

  it('get the City ID and sheet type from the sheet without being re-checked', async () => {
    const { refreshRowFields } = await import('@zoning/core');
    const fresh = buildRows(t, mapping).rows;
    const old = fresh.map(({ cityId, sheetType, ...rest }) => rest); // as an older version saved them
    const out = refreshRowFields(old, t, mapping);
    expect(out.map((r) => r.cityId)).toEqual(['3217', '88']);
    expect(out.map((r) => r.sheetType)).toEqual(['ArcGIS', 'PDF']);
    expect(out.map((r) => r.fingerprint)).toEqual(old.map((r) => r.fingerprint));
  });
  it('leave a row alone when its link in the sheet has changed since', async () => {
    const { refreshRowFields } = await import('@zoning/core');
    const changed = buildRows(t, mapping).rows.map((r) => ({ ...r, fingerprint: 'other', cityId: undefined }));
    expect(refreshRowFields(changed, t, mapping).map((r) => r.cityId)).toEqual([undefined, undefined]);
  });
  it('does nothing when the sheet or mapping is not saved', async () => {
    const { refreshRowFields } = await import('@zoning/core');
    const rows = buildRows(t, mapping).rows;
    expect(refreshRowFields(rows, null, mapping)).toBe(rows);
    expect(refreshRowFields(rows, t, null)).toBe(rows);
  });
});
