/** A zoning map PDF that states only "updated per Ordinance … - September 2026" (title block of the Manteca map). */
import { describe, expect, it } from 'vitest';
import { checkMap, findTextDates, pickTextDate, type CheckRow, type HttpResponse } from '@zoning/core';
import { readPdf } from '../apps/server/src/pdf';
import { fixedNow, MockHttp, testConfig } from './helpers';

function makePdf(lines: string[], info: Record<string, string> = {}): Uint8Array {
  const esc = (s: string) => s.replace(/[\()]/g, (c) => `\${c}`);
  const stream = `BT /F1 12 Tf 50 740 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const infoBody = Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(' ');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< ${infoBody} >>`];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const row = (url: string): CheckRow => ({ id: '11', sheetRow: 11, city: 'Manteca', state: 'CA', county: '', url, fingerprint: 'm', preIssues: [], extra: {} });
const reply = (b: Uint8Array): HttpResponse => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: '', bytes: b, url: '', ms: 1 });
const run = (bytes: Uint8Array) => checkMap(row('https://city.gov/zoning.pdf'), { http: new MockHttp([[/./, () => reply(bytes)]]), config: testConfig(), now: fixedNow, pdf: readPdf });

const TITLE_BLOCK = ['GEOGRAPHIC INFORMATION SYSTEMS', '1001 W CENTER ST', 'MANTECA, CA 95337', 'Zoning Map updated per Ordinance O2026-17 - September 2026', '\GIS\CityProjects\CDD\Zoning\Zoning.aprx'];

describe('"updated per Ordinance O2026-17 - September 2026"', () => {
  it('finds the month and year as an updated date, even though other words sit between the label and the date', () => {
    const found = findTextDates(TITLE_BLOCK.join('\n'), fixedNow());
    expect(found.map((d) => [d.date, d.format])).toEqual([['2026-09-01', 'month-year']]);
    expect(found[0].keyword).toMatch(/updated/i);
  });
  it('reads it when the sentence wraps onto a second line, as it does on the map', () => {
    const text = ['MANTECA, CA 95337', 'Zoning Map updated per Ordinance O2026-17 -', 'September 2026', '\\GIS\\CityProjects\\Zoning.aprx'].join('\n');
    const found = findTextDates(text, fixedNow());
    expect(found.map((d) => d.date)).toEqual(['2026-09-01']);
  });
  it('still ignores a month and year that no label leads to, or whose label belongs to an earlier sentence', () => {
    expect(findTextDates('Revised plan approved. The city of May 2021 residents', fixedNow())).toEqual([]);
    expect(findTextDates('Updated by staff. Meeting held in March 2022 at city hall.', fixedNow())).toEqual([]);
  });
  it('does not mistake the ordinance number for a date', () => {
    expect(findTextDates('Ordinance O2026-17', fixedNow())).toEqual([]);
  });
  it('picks it over an older date written elsewhere on the sheet', () => {
    const found = findTextDates([...TITLE_BLOCK, 'Previous adoption 12/17/2024'].join('\n'), fixedNow());
    expect(pickTextDate(found)?.date).toBe('2026-09-01');
  });
  it('uses the PDF’s own saved day when it falls in that month', async () => {
    const res = await run(makePdf([...TITLE_BLOCK, 'Previous adoption 12/17/2024'], { ModDate: 'D:20260917093000Z' }));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2026-09-17');
    expect(res.dateSource).toMatch(/^PDF:text/);
  });
  it('otherwise gives the first of the month and says only the month was stated', async () => {
    const res = await run(makePdf([...TITLE_BLOCK, 'Previous adoption 12/17/2024'], { ModDate: 'D:20250301000000Z' }));
    expect(res.primaryDate).toBe('2026-09-01');
    expect(res.issues.map((i) => i.reason).join(' ')).toMatch(/only the month/i);
  });
});
