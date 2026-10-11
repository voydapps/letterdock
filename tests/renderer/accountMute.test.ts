// @vitest-environment jsdom
// Mute in All inboxes (Account.inUnified): sidebar menu, muted icon, settings checkbox, Undo toast.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import type { Account } from '../../src/shared/ipc';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account = (o: Partial<Account> = {}): Account =>
  ({
    id: 'a1',
    email: 'a@example.com',
    displayName: 'Alpha',
    badge: '',
    color: null,
    signature: null,
    syncDays: 90,
    enabled: true,
    inUnified: true,
    authType: 'password',
    username: 'a',
    imap: { host: 'imap.example.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'ssl' },
    ...o,
  }) as unknown as Account;

const calls: { channel: string; req: unknown }[] = [];
let list: Account[] = [];

beforeEach(() => {
  calls.length = 0;
  (window as unknown as { api: unknown }).api = {
    invoke: (channel: string, req: unknown) => {
      calls.push({ channel, req });
      if (channel === 'accounts.list') return Promise.resolve(list);
      if (channel === 'accounts.update') return Promise.resolve(list[0]);
      return Promise.resolve([]);
    },
    on: () => () => undefined,
  };
});

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return { host, root };
}

describe('Mute in All inboxes', () => {
  it('sidebar menu label switches, the muted icon shows, and the action calls accounts.update with Undo', async () => {
    const { useApp } = await import('../../src/renderer/src/store/app');
    const { useUi } = await import('../../src/renderer/src/store/ui');
    const { useMenu } = await import('../../src/renderer/src/components/ui');
    const { useToasts } = await import('../../src/renderer/src/store/toasts');
    const { Sidebar } = await import('../../src/renderer/src/features/sidebar/Sidebar');
    useUi.getState().set({ sidebarCollapsed: false });
    useApp.setState({ settings: DEFAULT_SETTINGS, accounts: [account()], folders: [], counts: null as never, statuses: {} });
    list = [account()];
    const { host, root } = await mount(createElement(Sidebar));

    const row = () => host.querySelector<HTMLElement>('[role="treeitem"][aria-label^="Alpha"]')!;
    const labels = () =>
      useMenu.getState().menu!.items.filter((i) => i !== 'sep').map((i) => (i as { label: string }).label);

    expect(host.querySelector('.muted-ic')).toBeNull();
    await act(async () => {
      row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    let l = labels();
    expect(l).toContain('Mute in All inboxes');
    expect(l.indexOf('Mute in All inboxes')).toBe(l.indexOf('Account settings') + 1);
    expect(l.indexOf('Mute in All inboxes')).toBeLessThan(l.indexOf('Remove account...'));

    const entry = useMenu.getState().menu!.items.find((i) => typeof i === 'object' && 'label' in i && i.label === 'Mute in All inboxes') as {
      onSelect: () => void;
    };
    await act(async () => entry.onSelect());
    expect(calls.find((c) => c.channel === 'accounts.update')!.req).toEqual({ accountId: 'a1', patch: { inUnified: false } });
    const toastItem = useToasts.getState().items.find((t) => t.message === 'Account muted in All inboxes')!;
    expect(toastItem.actionLabel).toBe('Undo');
    calls.length = 0;
    await act(async () => toastItem.onAction!());
    expect(calls.find((c) => c.channel === 'accounts.update')!.req).toEqual({ accountId: 'a1', patch: { inUnified: true } });

    // Muted account: label flips and the small icon appears next to the name.
    await act(async () => useApp.setState({ accounts: [account({ inUnified: false })] }));
    await act(async () => {
      row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    l = labels();
    expect(l).toContain('Show in All inboxes');
    expect(l).not.toContain('Mute in All inboxes');
    const icon = host.querySelector('.muted-ic')!;
    expect(icon.getAttribute('aria-label')).toBe('Muted in All inboxes');
    expect(row().getAttribute('aria-label')).toContain('muted in All inboxes');
    await act(async () => root.unmount());
  });

  it('settings checkbox sends the inUnified patch', async () => {
    const { useApp } = await import('../../src/renderer/src/store/app');
    const { useUi } = await import('../../src/renderer/src/store/ui');
    const { SettingsPage } = await import('../../src/renderer/src/features/settings/SettingsPage');
    useApp.setState({ settings: DEFAULT_SETTINGS, accounts: [account()], statuses: {} });
    list = [account()];
    useUi.getState().openSettings('accounts', 'a1');
    const { host, root } = await mount(createElement(SettingsPage));
    const box = [...host.querySelectorAll<HTMLLabelElement>('label.cbx')]
      .find((l) => l.textContent?.includes('Include in All inboxes'))!
      .querySelector('input')!;
    expect(box.checked).toBe(true);
    expect(host.textContent).toContain("this account's mail stays in its own folders");
    await act(async () => box.click());
    expect(calls.find((c) => c.channel === 'accounts.update')!.req).toEqual({ accountId: 'a1', patch: { inUnified: false } });
    await act(async () => root.unmount());
  });
});
