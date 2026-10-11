// @vitest-environment jsdom
// Settings > Notifications: the "Show a test notification" button.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/main/settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Settings > Notifications test button', () => {
  it('calls notifications.test even when notifications are off, disables briefly, and shows errors', async () => {
    const calls: string[] = [];
    let fail = false;
    (window as unknown as { api: unknown }).api = {
      invoke: (channel: string) => {
        calls.push(channel);
        if (channel === 'notifications.test' && fail) {
          return Promise.reject({ code: 'unknown', message: 'Toast failed' });
        }
        return Promise.resolve(undefined);
      },
      on: () => () => undefined,
    };
    const { useApp } = await import('../../src/renderer/src/store/app');
    const { useUi } = await import('../../src/renderer/src/store/ui');
    const { useToasts } = await import('../../src/renderer/src/store/toasts');
    const { SettingsPage } = await import('../../src/renderer/src/features/settings/SettingsPage');
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } },
      accounts: [],
    });
    useUi.getState().openSettings('notifications', null);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(SettingsPage));
    });
    const btn = () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Show a test notification'))!;
    expect(btn().disabled).toBe(false);
    await act(async () => btn().click());
    expect(calls.filter((c) => c === 'notifications.test')).toHaveLength(1);
    expect(btn().disabled).toBe(true);
    await act(async () => new Promise((r) => setTimeout(r, 2100)));
    expect(btn().disabled).toBe(false);

    fail = true;
    await act(async () => btn().click());
    expect(useToasts.getState().items.some((t) => t.tone === 'danger')).toBe(true);
    await act(async () => root.unmount());
  });
});
