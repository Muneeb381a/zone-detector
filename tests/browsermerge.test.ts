/** A browser re-check that only says CORS_BLOCKED must not replace the server's specific error. */
import { describe, expect, it } from 'vitest';
import { mergeBrowserResult, type CheckResult } from '@zoning/core';

const result = (over: Partial<CheckResult>): CheckResult =>
  ({ id: '6', status: 'TIMEOUT', issues: [{ code: 'TIMEOUT', reason: 'No connection within 30 s.' }], issueReason: 'No connection within 30 s.', via: 'server', primaryDate: 'None', ...over }) as CheckResult;
const browserFail = result({ status: 'CORS_BLOCKED', via: 'browser', issues: [{ code: 'CORS_BLOCKED', reason: 'The browser could not read the answer.' }], issueReason: 'The browser could not read the answer.' });

describe('mergeBrowserResult', () => {
  it('keeps the server error and adds the failed browser attempt as a note', () => {
    const merged = mergeBrowserResult(result({}), browserFail);
    expect(merged.status).toBe('TIMEOUT');
    expect(merged.via).toBe('server');
    expect(merged.browserTried).toBe(true);
    expect(merged.issues.map((i) => i.code)).toEqual(['TIMEOUT', 'CORS_BLOCKED']);
    expect(merged.issueReason).toMatch(/^No connection within 30 s\. \| Re-checking from your browser also failed/);
  });
  it('does not stack the note when the browser fails again', () => {
    const once = mergeBrowserResult(result({}), browserFail);
    expect(mergeBrowserResult(once, browserFail)).toBe(once);
  });
  it('a browser result that worked replaces the server result', () => {
    const ok = result({ status: 'OK', via: 'browser', issues: [], issueReason: '', primaryDate: '2026-01-02' });
    expect(mergeBrowserResult(result({}), ok)).toBe(ok);
  });
  it('another real browser error replaces it too, and a missing earlier result takes the browser one', () => {
    const e404 = result({ status: 'HTTP_404', via: 'browser' });
    expect(mergeBrowserResult(result({}), e404)).toBe(e404);
    expect(mergeBrowserResult(undefined, browserFail)).toBe(browserFail);
  });
});
