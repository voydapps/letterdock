// @vitest-environment jsdom
// After a new password, the "sign in again" message must go away as soon as the engine moves on.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, AccountStatus } from '../../src/shared/ipc';
import { useApp } from '../../src/renderer/src/store/app';
import { leftModel } from '../../src/renderer/src/lib/statusBar';

const acc = { id: 'a1', displayName: 'Gmail', email: 'a@x.example', enabled: true } as Account;
const st = (state: AccountStatus['state'], over: Partial<AccountStatus> = {}): AccountStatus => ({
  accountId: 'a1',
  state,
  lastSyncAt: null,
  error: null,
  nextRetryAt: null,
  pendingCount: 0,
  ...over,
});
const kind = () => {
  const s = useApp.getState();
  return leftModel({ accounts: [acc], statuses: s.statuses, authRequired: s.authRequired, online: true, progress: {}, now: 0 });
};

describe('sign in again message in the status bar', () => {
  beforeEach(() => useApp.setState({ statuses: {}, authRequired: {} }));

  const fail = () => {
    useApp.getState().handleEvent({ type: 'account:status', status: st('auth_failed', { error: { code: 'AUTH_FAILED', message: 'x', retryable: false } }) });
    useApp.getState().handleEvent({ type: 'account:authRequired', accountId: 'a1', reason: 'password' });
  };

  it('shows the message while the account needs sign-in', () => {
    fail();
    expect(kind().kind).toBe('auth');
    expect(kind().text).toContain('sign in again');
  });

  it.each(['connecting', 'retrying', 'offline', 'online'] as const)('goes away when the engine reports %s', (state) => {
    fail();
    useApp.getState().handleEvent({ type: 'account:status', status: st(state) });
    expect(useApp.getState().authRequired.a1).toBeUndefined();
    expect(kind().kind).not.toBe('auth');
  });

  it('stays when the password is refused again', () => {
    fail();
    useApp.getState().handleEvent({ type: 'account:status', status: st('connecting') });
    fail();
    expect(kind().kind).toBe('auth');
  });
});
