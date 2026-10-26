/** Map type (interactive map or PDF) and the count of PDF files behind a link. */
import { describe, expect, it } from 'vitest';
import { applyFilters, buildRows, checkMap, findPdfLinks, mapTypeOf, NO_FILTERS, parseCsv, summarizeTypes, type CheckResult, type CheckRow, type HttpResponse } from '@zoning/core';
import { readPdf } from '../apps/server/src/pdf';
import { fixedNow, MockHttp, reply, row, SVC, testConfig, zoningService } from './helpers';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
const pdfReply = (): HttpResponse => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: '', bytes: PDF_BYTES, url: '', ms: 1 });
const html = (body: string, url = ''): HttpResponse => ({ status: 200, headers: { 'content-type': 'text/html' }, body, url, ms: 1 });
const run = (url: string, http: MockHttp, rowOver: Partial<CheckRow> = {}) => checkMap(row(url, rowOver), { http, config: testConfig(), now: fixedNow, pdf: readPdf });

const PAGE = `<html><body>
  <a href="/files/zoning-map-2023.pdf">Zoning Map (PDF)</a>
  <a href="https://cdn.city.gov/future-land-use.PDF?v=2">Future land use</a>
  <a href="/files/zoning-map-2023.pdf">Zoning Map again</a>
  <a href="/about.html">About</a><a href="mailto:x@y.gov">mail</a>
  <iframe src="docs/overlay.pdf#page=2"></iframe>
</body></html>`;

describe('PDF links on a web page', () => {
  it('lists each PDF once, resolved against the page address', () => {
    expect(findPdfLinks(PAGE, 'https://city.gov/planning/maps/')).toEqual([
      'https://city.gov/files/zoning-map-2023.pdf',
      'https://cdn.city.gov/future-land-use.PDF?v=2',
      'https://city.gov/planning/maps/docs/overlay.pdf#page=2',
    ]);
    expect(findPdfLinks('<a href="/a.html">x</a>', 'https://x.gov')).toEqual([]);
  });
});

describe('what each check reports', () => {
  it('an ArcGIS map is interactive, with no PDFs', async () => {
    const res = await run(SVC, zoningService());
    expect(res.status).toBe('OK');
    expect(res).toMatchObject({ mapType: 'interactive', pdfCount: 0 });
    expect(res.pdfLinks).toBeUndefined();
  });
  it('a PDF file is one PDF', async () => {
    const res = await run('https://city.gov/zoning.pdf', new MockHttp([[/./, () => pdfReply()]]));
    expect(res).toMatchObject({ mapType: 'pdf', pdfCount: 1, pdfLinks: ['https://city.gov/zoning.pdf'] });
  });
  it('a web page that lists PDFs is counted, and the reason says how many', async () => {
    const res = await run('https://city.gov/planning/maps/', new MockHttp([[/./, () => html(PAGE, 'https://city.gov/planning/maps/')]]));
    expect(res.status).toBe('NOT_ARCGIS');
    expect(res).toMatchObject({ mapType: 'pdf', pdfCount: 3 });
    expect(res.pdfLinks).toHaveLength(3);
    expect(res.issueReason).toMatch(/links to 3 PDF files \(zoning-map-2023\.pdf, future-land-use\.PDF, overlay\.pdf\)/);
  });
  it('a web page with no PDFs keeps the old message and is not typed', async () => {
    const res = await run('https://city.gov/zoning', new MockHttp([[/./, () => html('<html>hello</html>')]]));
    expect(res.issueReason).toMatch(/Find the REST endpoint/);
    expect(res.mapType).toBe('unknown');
    expect(res.pdfCount).toBe(0);
  });
  it('a failing ArcGIS link is still known to be an interactive map by its address', async () => {
    const res = await run(SVC, new MockHttp([[/./, () => reply('', 404)]]));
    expect(res.status).toBe('HTTP_404');
    expect(res.mapType).toBe('interactive');
  });
  it('a viewer that links to PDFs reports how many', async () => {
    const APP = '0123456789abcdef0123456789abcdef';
    const json = (b: object): HttpResponse => reply(b);
    const http = new MockHttp([
      [new RegExp(`items/${APP}\\?f=json`), () => json({ id: APP, type: 'Web Mapping Application', title: 'Zoning' })],
      [new RegExp(`items/${APP}/data\\?f=json`), () => json({ values: { documents: ['https://city.gov/a.pdf', 'https://city.gov/b.pdf'] } })],
      [/\.pdf/, () => pdfReply()],
    ]);
    const res = await run(`https://city.maps.arcgis.com/apps/instant/index.html?appid=${APP}`, http);
    expect(res).toMatchObject({ mapType: 'pdf', pdfCount: 2 });
  });
});

describe('mapTypeOf', () => {
  const r = (over: Partial<CheckResult>) => ({ id: '2', status: 'OK', serviceType: 'MapServer', sourceUrl: '', issues: [], ...over }) as unknown as CheckResult;

  it('uses what the check found', () => {
    expect(mapTypeOf(row(SVC), r({ mapType: 'pdf', pdfCount: 4 }))).toMatchObject({ type: 'pdf', label: 'PDF', pdfCount: 4, basis: 'checked' });
  });
  it('works out results stored before the field existed', () => {
    expect(mapTypeOf(row(SVC), r({}))).toMatchObject({ type: 'interactive', pdfCount: 0 });
    expect(mapTypeOf(row('https://x.gov/a.pdf'), r({ serviceType: 'PDF' }))).toMatchObject({ type: 'pdf', pdfCount: 1 });
  });
  it('knows a row from its link before it is checked', () => {
    expect(mapTypeOf(row('https://x.gov/a.pdf'))).toMatchObject({ type: 'pdf', basis: 'link', pdfCount: 1 });
    expect(mapTypeOf(row(SVC))).toMatchObject({ type: 'interactive', basis: 'link' });
    expect(mapTypeOf(row('https://x.gov/zoning-page'))).toMatchObject({ type: 'unknown', label: '—' });
  });
  it('falls back to the sheet\'s own type for a row with no usable link, and says so', () => {
    expect(mapTypeOf(row('', { sheetType: 'PDF' }))).toMatchObject({ type: 'pdf', basis: 'sheet', mismatch: false });
  });
  it('flags a disagreement between the sheet and the link', () => {
    expect(mapTypeOf(row(SVC, { sheetType: 'PDF' }))).toMatchObject({ type: 'interactive', sheetType: 'pdf', mismatch: true });
    expect(mapTypeOf(row(SVC, { sheetType: 'ArcGIS' })).mismatch).toBe(false);
  });
});

describe('the sheet\'s type column, filters, summary and CSV', () => {
  const csv = [
    'City,State,Endpoint_Links,Type PDF: 1 | AG: 3',
    `A,TX,${SVC},ArcGIS`,
    'B,TX,https://b.gov/atlas.pdf,PDF',
    `C,TX,${SVC.replace('Zoning', 'Other')},PDF`,
    'D,TX,,PDF',
  ].join('\n');
  const rows = buildRows(parseCsv(csv), { city: 0, state: 1, county: null, url: 2, altUrl: null }).rows;

  it('carries the sheet type onto each row', () => {
    expect(rows.map((x) => x.sheetType)).toEqual(['ArcGIS', 'PDF', 'PDF', 'PDF']);
  });
  it('counts types, PDF files and disagreements', () => {
    expect(summarizeTypes(rows, {})).toEqual({ interactive: 2, pdf: 2, unknown: 0, pdfFiles: 2, mismatches: 1 });
  });
  it('filters by type', () => {
    expect(applyFilters(rows, {}, { ...NO_FILTERS, type: 'pdf' }).map((d) => d.row.city)).toEqual(['B', 'D']);
    expect(applyFilters(rows, {}, { ...NO_FILTERS, type: 'interactive' }).map((d) => d.row.city)).toEqual(['A', 'C']);
    expect(applyFilters(rows, {}, { ...NO_FILTERS, text: 'pdf' }).map((d) => d.row.city)).toEqual(['B', 'D']);
  });
});
