// @vitest-environment jsdom
// The main window's ways to open .eml files (DESIGN-SPEC 3.14.2): Ctrl+O, the command, and a drop.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmlOpenRes } from '../../src/shared/ipc';

const calls: { channel: string; req: unknown }[] = [];
let answer: EmlOpenRes;

async function setup() {
  vi.resetModules();
  calls.length = 0;
  (window as unknown as { api: unknown }).api = {
    invoke: (channel: string, req?: unknown) => {
      calls.push({ channel, req });
      return Promise.resolve(answer);
    },
    on: () => () => undefined,
    pathForFile: (f: File) => (f.name === 'nopath.eml' ? '' : `D:/drop/${f.name}`),
  };
  const toasts = (await import('../../src/renderer/src/store/toasts')).useToasts;
  toasts.setState({ items: [] });
  const actions = await import('../../src/renderer/src/lib/actions');
  return { actions, texts: () => toasts.getState().items.map((t) => t.message) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('open .eml files from the main window', () => {
  beforeEach(() => {
    answer = { opened: 0, total: 0, notice: null, errors: [] };
  });

  it('a drop sends the paths of the files and toasts every error and the notice', async () => {
    const { actions, texts } = await setup();
    answer = {
      opened: 5,
      total: 8,
      notice: 'Opened the first 5 of 8 files.',
      errors: [{ code: 'wrongType', message: 'Letterdock opens .eml files only.', fileName: 'c.txt' }],
    };
    actions.openDroppedFiles([new File(['x'], 'a.eml'), new File(['x'], 'c.txt')]);
    await flush();
    expect(calls).toEqual([{ channel: 'eml.openPaths', req: { paths: ['D:/drop/a.eml', 'D:/drop/c.txt'] } }]);
    expect(texts()).toEqual(['Letterdock opens .eml files only.', 'Opened the first 5 of 8 files.']);
  });

  it('a drop with no files asks nothing', async () => {
    const { actions } = await setup();
    actions.openDroppedFiles([]);
    await flush();
    expect(calls).toEqual([]);
  });

  it('Ctrl+O and the command use the file picker and toast the same way', async () => {
    const { actions, texts } = await setup();
    answer = { opened: 0, total: 1, notice: null, errors: [{ code: 'tooLarge', message: 'This file is too large to open (limit 50 MB).', fileName: 'x.eml' }] };
    actions.pickEmlFiles();
    await flush();
    expect(calls).toEqual([{ channel: 'eml.pickFiles', req: undefined }]);
    expect(texts()).toEqual(['This file is too large to open (limit 50 MB).']);
  });

  it('a clean open shows no toast', async () => {
    const { actions, texts } = await setup();
    answer = { opened: 1, total: 1, notice: null, errors: [] };
    actions.pickEmlFiles();
    await flush();
    expect(texts()).toEqual([]);
  });

  it('the command box lists "Open .eml file..." with Ctrl+O, also with no account', async () => {
    await setup();
    const { buildCommands } = await import('../../src/renderer/src/features/light/commands');
    const c = buildCommands().find((x) => x.id === 'openEml');
    expect(c).toMatchObject({ label: 'Open .eml file...', hint: 'Ctrl+O' });
  });
});
