// @vitest-environment jsdom
// After a new password is saved, the dialog tells the truth: Connecting... until the account is really up.
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, AccountStatus } from '../../src/shared/ipc';
import type * as AppStore from '../../src/renderer/src/store/app';
import { connectOutcome } from '../../src/renderer/src/lib/connectWait';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const acc = { id: 'a1', displayName: 'Gmail', email: 'a@x.example', enabled: true, authType: 'password', imap: { host: 'imap.example.com' } } as unknown as Account;
const st = (state: AccountStatus['state']): AccountStatus => ({ accountId: 'a1', state, lastSyncAt: null, error: null, nextRetryAt: null, pendingCount: 0 });

describe('connectOutcome', () => {
  it('maps states', () => {
    const old = st('auth_failed');
    expect(connectOutcome(undefined, old)).toBe('waiting');
    expect(connectOutcome(st('connecting'), old)).toBe('waiting');
    expect(connectOutcome(st('retrying'), old)).toBe('waiting');
    expect(connectOutcome(st('online'), old)).toBe('online');
    expect(connectOutcome(st('syncing'), old)).toBe('online');
    expect(connectOutcome(st('offline'), old)).toBe('offline');
    expect(connectOutcome(old, old)).toBe('waiting');
    expect(connectOutcome(st('auth_failed'), old)).toBe('auth_failed');
  });
});

describe.each(['sign-in', 'settings'] as const)('%s dialog', (which) => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let useApp: typeof AppStore.useApp;
  let toasts: string[];

  const emit = (state: AccountStatus['state']) =>
    act(async () => useApp.getState().handleEvent({ type: 'account:status', status: st(state) }));
  const text = () => host.textContent ?? '';

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (window as unknown as { api: unknown }).api = {
      invoke: (ch: string) => Promise.resolve(ch === 'accounts.statuses' ? [st('auth_failed')] : undefined),
      on: () => () => undefined,
    };
    ({ useApp } = await import('../../src/renderer/src/store/app'));
    const t = await import('../../src/renderer/src/store/toasts');
    toasts = [];
    t.useToasts.subscribe((s) => { for (const i of s.items) if (!toasts.includes(i.message)) toasts.push(i.message); });
    useApp.setState({ accounts: [acc], statuses: { a1: st('auth_failed') }, authRequired: {} });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onClose = () => undefined;
    const el = which === 'sign-in'
      ? createElement((await import('../../src/renderer/src/features/account/AddAccountDialog')).AddAccountDialog, { request: { reauthAccountId: 'a1' } as never })
      : createElement((await import('../../src/renderer/src/features/settings/SettingsPage')).PasswordDialog, { accountId: 'a1', onClose });
    await act(async () => root.render(el));
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'secret');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('says Connecting... and not Connected until the account is online', async () => {
    expect(text()).toContain('Connecting...');
    await emit('connecting');
    expect(text()).toContain('Connecting...');
    expect(toasts.join()).not.toMatch(/connected/i);
    await emit('online');
    expect(text()).not.toContain('Connecting...');
    expect(toasts.join()).toMatch(/connected/i);
  });

  it('offline: saved, will connect later', async () => {
    await emit('offline');
    expect(toasts.join()).toContain("back online");
  });

  it('refused again: shows the error and the form', async () => {
    await emit('connecting');
    await emit('auth_failed');
    expect(text()).toContain('The server rejected the password');
    expect(text()).not.toContain('Connecting...');
    expect(toasts.join()).not.toMatch(/connected/i);
  });

  it('gives up waiting after 15 s', async () => {
    await act(async () => { vi.advanceTimersByTime(15_100); });
    expect(toasts.join()).toContain('Still connecting');
  });
});
