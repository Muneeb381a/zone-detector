/** The export repeats the sheet's TML and Endpoint link cells as its last two columns. */
import { describe, expect, it } from 'vitest';
import { buildFullCsv, buildIssuesCsv, buildRows, parseCsv } from '@zoning/core';
import type { CheckResult } from '@zoning/core';

const table = parseCsv('100 - IDs,100 - Cities,20 - States,TML: 100 | NMF: 0,100 - Endpoint_Links\n3217,Opelika,AL,https://a.gov/viewer?id=1,https://a.gov/x/MapServer/3');
const mapping = { city: 1, state: 2, county: null, url: 4 };

describe('sheet link columns in the export', () => {
  const rows = buildRows(table, mapping).rows;
  const result = { id: rows[0].id, city: 'Opelika', county: '', state: 'AL', sourceUrl: rows[0].url, normalizedUrl: rows[0].url, serviceType: 'MapServer', primaryDate: '2025-01-02', reviewDate: '2026-01-01', evidenceUrl: '', issues: [], status: 'OK' } as unknown as CheckResult;

  it('adds TML Link and Endpoint Link when the sheet rows are given', () => {
    const out = parseCsv(buildFullCsv([result], rows, '100 - Endpoint_Links'));
    expect(out[0].slice(-2)).toEqual(['TML Link', 'Endpoint Link']);
    expect(out[1].slice(-2)).toEqual(['https://a.gov/viewer?id=1', 'https://a.gov/x/MapServer/3']);
  });
  it('keeps the old shape without rows, and the issues export gets the same columns', () => {
    expect(parseCsv(buildFullCsv([result]))[0]).toHaveLength(11);
    expect(parseCsv(buildIssuesCsv([], rows))[0]).toHaveLength(13);
  });
});
