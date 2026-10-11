// @vitest-environment jsdom
// Settings > Notifications: the two unread-badge checkboxes (DESIGN-SPEC 3.15).
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/main/settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Settings > Notifications badge rows', () => {
  it('render, are not gated by notifications, and toggle badgeTaskbar and badgeTray', async () => {
    const patches: unknown[] = [];
    let saved = {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false },
      badgeTaskbar: true,
      badgeTray: false,
    };
    (window as unknown as { api: unknown }).api = {
      invoke: (channel: string, req: Record<string, unknown>) => {
        if (channel === 'settings.set') patches.push(req);
        saved = { ...saved, ...req };
        return Promise.resolve(saved);
      },
      on: () => () => undefined,
    };
    const { useApp } = await import('../../src/renderer/src/store/app');
    const { useUi } = await import('../../src/renderer/src/store/ui');
    const { SettingsPage } = await import('../../src/renderer/src/features/settings/SettingsPage');
    useApp.setState({ settings: saved, accounts: [] });
    useUi.getState().openSettings('notifications', null);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(SettingsPage));
    });

    const boxes = (label: string) =>
      [...host.querySelectorAll<HTMLLabelElement>('label.cbx')].find((l) => l.textContent?.includes(label))!
        .querySelector('input')!;
    const taskbar = boxes('unread count on the taskbar icon');
    const tray = boxes('dot on the tray icon');
    expect(taskbar.checked).toBe(true);
    expect(tray.checked).toBe(false);
    expect(taskbar.disabled).toBe(false);
    expect(tray.disabled).toBe(false);

    await act(async () => {
      taskbar.click();
    });
    await act(async () => {
      tray.click();
    });
    expect(patches).toEqual([{ badgeTaskbar: false }, { badgeTray: true }]);
    await act(async () => root.unmount());
  });
});
