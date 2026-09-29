import { describe, expect, it } from 'vitest';
import { registerSecret } from '@pager/core';
import { WITHHELD, statusFor } from '../src/status-view.ts';

const status = {
  lastOutcome: 'tick failed: GET https://api.github.com/repos/a/b/pulls/12 failed with 502: {"message":"upstream"}',
  approvals: [{ id: 'a1', pullRequest: 12, approvedBy: 'ada.lovelace', outcome: 'merge failed: PUT https://api.github.com/... failed with 405: {"message":"Required status check"}' }],
  stage: 'idle',
};

describe('status view', () => {
  it('withholds approver names and raw vendor errors from a remote reader', () => {
    const view = statusFor(status, { remoteAddress: '10.0.4.12', publicStatus: false });
    expect(view.approvals[0]!.approvedBy).toBe(WITHHELD);
    expect(view.approvals[0]!.outcome).toBe(`merge failed: ${WITHHELD}`);
    expect(view.lastOutcome).toBe(`tick failed: ${WITHHELD}`);
    expect(JSON.stringify(view)).not.toMatch(/ada\.lovelace|api\.github\.com/);
  });

  it('serves the full record to loopback, or to everyone when the operator opts in', () => {
    expect(statusFor(status, { remoteAddress: '127.0.0.1', publicStatus: false }).approvals[0]!.approvedBy).toBe('ada.lovelace');
    expect(statusFor(status, { remoteAddress: '::1', publicStatus: false }).approvals[0]!.approvedBy).toBe('ada.lovelace');
    expect(statusFor(status, { remoteAddress: '10.0.4.12', publicStatus: true }).approvals[0]!.approvedBy).toBe('ada.lovelace');
  });

  it('redacts credentials in every view, including the full one', () => {
    registerSecret('xoxb-status-page-secret-000');
    const leaky = { ...status, lastOutcome: 'posted with xoxb-status-page-secret-000' };
    expect(JSON.stringify(statusFor(leaky, { remoteAddress: '127.0.0.1', publicStatus: true }))).not.toContain('xoxb-status');
  });
});
