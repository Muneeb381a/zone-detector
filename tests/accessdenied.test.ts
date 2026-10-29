import { describe, expect, it } from 'vitest';
import { accessDeniedMessage } from '@zoning/core';

describe('why a 401/403 happened', () => {
  it('login wording means a private service', () => expect(accessDeniedMessage(401, '<html><body>Please sign in to continue</body></html>')).toMatch(/private and needs a login/));
  it('firewall wording means a network or location block, and quotes the server', () => {
    const m = accessDeniedMessage(403, '<html><title>Access Denied</title><p>Request blocked by security policy</p></html>');
    expect(m).toMatch(/blocks this request/);
    expect(m).toContain('Request blocked by security policy');
  });
  it('says so when the server explains nothing', () => expect(accessDeniedMessage(403, '')).toMatch(/gave no explanation/));
});
