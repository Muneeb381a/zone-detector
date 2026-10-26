/** PDF maps: the date written in the text wins; otherwise the document properties (ModDate, then CreationDate). */
import { describe, expect, it } from 'vitest';
import { buildRows, checkMap, findTextDates, isPdfUrl, parseCsv, parsePdfDate, pickTextDate, type CheckRow, type HttpResponse } from '@zoning/core';
import { readPdf } from '../apps/server/src/pdf';
import { fixedNow, MockHttp, testConfig } from './helpers';

/** A real, minimal one-page PDF with the given lines of text and optional Info dictionary entries. */
function makePdf(lines: string[], info: Record<string, string> = {}): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = lines.length ? `BT /F1 12 Tf 50 740 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET` : '';
  const infoBody = Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< ${infoBody} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const row = (url: string): CheckRow => ({ id: '2', sheetRow: 2, city: 'Testville', state: 'TX', county: '', url, fingerprint: 'x', preIssues: [], extra: {} });
const pdfReply = (bytes: Uint8Array, headers: Record<string, string> = { 'content-type': 'application/pdf' }): HttpResponse => ({ status: 200, headers, body: '', bytes, url: '', ms: 5 });
const run = (url: string, bytes: Uint8Array, headers?: Record<string, string>) =>
  checkMap(row(url), { http: new MockHttp([[/./, () => pdfReply(bytes, headers)]]), config: testConfig(), now: fixedNow, pdf: readPdf });

describe('PDF dates in document properties', () => {
  it('parses PDF date strings into UTC', () => {
    expect(parsePdfDate("D:20230514103000+05'00'")?.date).toBe('2023-05-14');
    expect(parsePdfDate("D:20230514233000-05'00'")?.date).toBe('2023-05-15'); // 23:30 at -05:00 is already the 15th in UTC
    expect(parsePdfDate('D:2021')?.date).toBe('2021-01-01');
    expect(parsePdfDate('D:20231340')).toBeNull();
    expect(parsePdfDate('garbage')).toBeNull();
  });
  it('recognises PDF links', () => {
    expect(isPdfUrl('https://city.gov/maps/zoning.pdf')).toBe(true);
    expect(isPdfUrl('https://city.gov/maps/zoning.PDF?v=2')).toBe(true);
    expect(isPdfUrl('https://city.gov/arcgis/rest/services/Zoning/MapServer')).toBe(false);
  });
});

describe('dates written in the text', () => {
  it('finds common formats and the label in front of each', () => {
    const found = findTextDates('Adopted: June 5, 2023. Last Revised 03/14/2024. Printed 2022-11-02. Ordinance 1987-45.', fixedNow());
    expect(found.map((d) => d.date)).toEqual(['2023-06-05', '2024-03-14', '2022-11-02']);
    expect(found[1].keyword?.toLowerCase()).toContain('last revised');
  });
  it('prefers the newest labelled date, and ignores future dates', () => {
    const found = findTextDates('Effective January 1, 2020  Revised 04/09/2022  Next update 05/05/2099', fixedNow());
    expect(pickTextDate(found)?.date).toBe('2022-04-09');
  });
  it('falls back to the newest unlabelled date when nothing is labelled', () => {
    expect(pickTextDate(findTextDates('Map of 12 March 2019 and 7 August 2021', fixedNow()))?.date).toBe('2021-08-07');
  });
  it('reads day-first only when the first number cannot be a month', () => {
    expect(findTextDates('Updated 25/03/2023', fixedNow())[0].date).toBe('2023-03-25');
    expect(findTextDates('Updated 04/05/2023', fixedNow())[0]).toMatchObject({ date: '2023-04-05', ambiguous: true });
  });
  it('takes a month and year only next to a label', () => {
    expect(findTextDates('Revised May 2021', fixedNow())[0].date).toBe('2021-05-01');
    expect(findTextDates('The city of May 2021 residents', fixedNow())).toEqual([]);
  });
});

describe('checkMap on a PDF', () => {
  it('uses the date written in the PDF text as the Primary Date', async () => {
    const res = await run('https://city.gov/zoning.pdf', makePdf(['City of Testville Zoning Map', 'Last Revised: June 5, 2023'], { ModDate: "D:20200101000000Z" }));
    expect(res.status).toBe('OK');
    expect(res.serviceType).toBe('PDF');
    expect(res.primaryDate).toBe('2023-06-05');
    expect(res.dateSource).toMatch(/^PDF:text/);
  });
  it('falls back to the document properties (ModDate) when the text has no date', async () => {
    const res = await run('https://city.gov/zoning.pdf', makePdf(['City of Testville Zoning Map'], { CreationDate: "D:20190301000000Z", ModDate: "D:20210714120000Z" }));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2021-07-14');
    expect(res.dateSource).toBe('PDF:ModDate');
    expect(res.issues.map((i) => i.code)).toContain('DATE_FROM_PDF_PROPERTIES');
  });
  it('uses CreationDate when there is no ModDate', async () => {
    const res = await run('https://city.gov/zoning.pdf', makePdf(['Zoning'], { CreationDate: "D:20190301000000Z" }));
    expect(res.primaryDate).toBe('2019-03-01');
    expect(res.dateSource).toBe('PDF:CreationDate');
  });
  it('reports OK_NO_DATE when there is no date anywhere', async () => {
    const res = await run('https://city.gov/zoning.pdf', makePdf(['Zoning']));
    expect(res.status).toBe('OK_NO_DATE');
    expect(res.primaryDate).toBe('None');
  });
  it('reads a PDF behind a link that does not end in .pdf (by content type)', async () => {
    const res = await run('https://city.gov/download?id=7', makePdf(['Adopted 02/10/2022']));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2022-02-10');
  });
  it('fails clearly when the file is not a PDF', async () => {
    const res = await run('https://city.gov/zoning.pdf', new TextEncoder().encode('<html>not a pdf</html>'));
    expect(res.status).toBe('NOT_ARCGIS');
  });
  it('fails clearly when no PDF reader is available (browser re-check)', async () => {
    const res = await checkMap(row('https://city.gov/zoning.pdf'), { http: new MockHttp([[/./, () => pdfReply(makePdf(['x']))]]), config: testConfig(), now: fixedNow });
    expect(res.status).toBe('NOT_ARCGIS');
    expect(res.issueReason).toMatch(/server only/);
  });
});

describe('a viewer whose map is a PDF', () => {
  const APP = '0123456789abcdef0123456789abcdef';
  const pdf = makePdf(['Zoning Map', 'Last Revised: 02/11/2024']);
  const portal = (item: object, data: object | null) =>
    new MockHttp([
      [new RegExp(`items/${APP}\\?f=json`), () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: APP, title: 'Zoning', ...item }), url: '', ms: 1 })],
      [new RegExp(`items/${APP}/data\\?f=json`), () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}), url: '', ms: 1 })],
      [new RegExp(`items/${APP}/data$`), () => pdfReply(pdf)],
      [/zoning\.pdf/, () => pdfReply(pdf)],
    ]);
  const check = (http: MockHttp) => checkMap(row(`https://city.maps.arcgis.com/apps/instant/media/index.html?appid=${APP}`), { http, config: testConfig(), now: fixedNow, pdf: readPdf });

  it('reads an ArcGIS item of type PDF', async () => {
    const res = await check(portal({ type: 'PDF', modified: 1700000000000 }, null));
    expect(res.status).toBe('OK');
    expect(res.serviceType).toBe('PDF');
    expect(res.primaryDate).toBe('2024-02-11');
  });
  it('reads a PDF linked from the app data when there is no service', async () => {
    const res = await check(portal({ type: 'Web Mapping Application', modified: 1700000000000 }, { values: { documents: ['https://city.gov/files/zoning.pdf'] } }));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2024-02-11');
    expect(res.resolvedFrom).toContain('zoning.pdf');
  });
});

describe('an empty Map URL is looked for in the other columns of the row', () => {
  const csv = [
    'City,State,TML: 3 | NMF: 0,Endpoint_Links,Type PDF: 1 | AG: 2',
    'A,TX,https://city.maps.arcgis.com/apps/instant/index.html?appid=0123456789abcdef0123456789abcdef,,PDF',
    'B,TX,https://b.gov/viewer,,PDF',
    'C,TX,https://c.gov/atlas/zoning-map.pdf,,PDF',
    'D,TX,,,AG',
    'E,TX,https://e.gov/viewer,https://e.gov/x/MapServer,AG',
  ].join('\n');
  const table = parseCsv(csv);
  const mapping = { city: 0, state: 1, county: null, url: 3 };

  it('takes the viewer link, or better a PDF link, and says which column it came from', () => {
    const r = buildRows(table, mapping).rows;
    expect(r.map((x) => x.url)).toEqual([
      'https://city.maps.arcgis.com/apps/instant/index.html?appid=0123456789abcdef0123456789abcdef',
      'https://b.gov/viewer',
      'https://c.gov/atlas/zoning-map.pdf',
      '',
      'https://e.gov/x/MapServer', // its own endpoint wins
    ]);
    expect(r[2]).toMatchObject({ fallback: true, fallbackColumn: expect.stringContaining('TML') });
    expect(r[4].fallback).toBeUndefined();
  });
  it('when nothing is found, URL_EMPTY says what was looked at, and uses the sheet\'s own PDF label', async () => {
    const t2 = parseCsv('City,State,Type PDF: 1 | AG: 1,Endpoint_Links\nA,TX,PDF,\nB,TX,AG,');
    const [a, b] = buildRows(t2, { city: 0, state: 1, county: null, url: 3 }).rows;
    expect(a.hint).toMatch(/marks this map as a PDF/);
    expect(b.hint).toMatch(/No PDF or viewer link/);
    const res = await checkMap(a, { http: new MockHttp([]), config: testConfig(), now: fixedNow });
    expect(res.status).toBe('URL_EMPTY');
    expect(res.issueReason).toMatch(/Map URL cell is empty.*marks this map as a PDF/);
  });
  it('the PDF found in another column is then read for its date', async () => {
    const [, , c] = buildRows(table, mapping).rows;
    const res = await checkMap(c, { http: new MockHttp([[/zoning-map\.pdf/, () => pdfReply(makePdf(['Adopted June 5, 2022']))]]), config: testConfig(), now: fixedNow, pdf: readPdf });
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2022-06-05');
  });
});
