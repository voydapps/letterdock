// @vitest-environment jsdom
// Settings > Mail: "Download new mail in the background" (prefetchDays).
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/main/settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Settings > Mail prefetch row', () => {
  it('shows the choices, the help text, and sends the picked number', async () => {
    const patches: unknown[] = [];
    (window as unknown as { api: unknown }).api = {
      invoke: (channel: string, payload: unknown) => {
        if (channel === 'settings.set') {
          patches.push(payload);
          return Promise.resolve({ ...DEFAULT_SETTINGS, ...(payload as object) });
        }
        return Promise.resolve(undefined);
      },
      on: () => () => undefined,
    };
    const { useApp } = await import('../../src/renderer/src/store/app');
    const { useUi } = await import('../../src/renderer/src/store/ui');
    const { SettingsPage } = await import('../../src/renderer/src/features/settings/SettingsPage');
    useApp.setState({ settings: { ...DEFAULT_SETTINGS }, accounts: [] });
    useUi.getState().openSettings('mail', null);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(SettingsPage));
    });
    const sel = host.querySelector<HTMLSelectElement>('select[aria-describedby="prefetch-days-help"]')!;
    expect(sel).toBeTruthy();
    expect(host.querySelector(`label[for="${sel.id}"]`)?.textContent).toBe('Download new mail in the background');
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([
      ['0', 'Off'],
      ['7', 'Last 7 days'],
      ['30', 'Last 30 days'],
      ['90', 'Last 90 days'],
      ['-1', 'All mail'],
    ]);
    expect(sel.value).toBe('30');
    expect(host.querySelector('#prefetch-days-help')?.textContent).toBe(
      'Mail is downloaded ahead of time so it opens at once and can be searched without a connection. Uses space from the limit above.',
    );
    for (const v of ['-1', '0']) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(sel, v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    expect(patches).toEqual([{ prefetchDays: -1 }, { prefetchDays: 0 }]);
    await act(async () => root.unmount());
  });
});
