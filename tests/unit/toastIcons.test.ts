// Icons on the notification buttons, clean toast text and the test notification (DESIGN-SPEC 3.13.3a).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Notifier, type ToastSpec } from '../../src/main/notifications';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import { schemas } from '../../src/main/ipcSchemas';
import { MAIN_CHANNELS } from '../../src/shared/channels';
import { buildToastXml, encodeActivationArgs, fileUri, TEST_TOAST_CONTEXT } from '../../src/main/toast';
import { onToastActivation } from '../../src/main/toastActions';
import { resolveToastIcons, toastIconsDir } from '../../src/main/toastIcons';
import { capLine, mailLines, previewLine } from '../../src/main/toastText';
import type { MessageHeader } from '../../src/shared/ipc';

const repo = resolve(__dirname, '..', '..');
const devDir = toastIconsDir({ isPackaged: false, resourcesPath: 'R', appPath: repo });
const buttons = [
  { action: 'read' as const, label: 'Mark as read' },
  { action: 'archive' as const, label: 'Archive' },
  { action: 'delete' as const, label: 'Delete' },
];
const ctx = { accountId: 'a1', messageId: 5 };

describe('toast icon files and paths', () => {
  it('uses resources/toast-icons when packaged and build/toast-icons in development', () => {
    expect(toastIconsDir({ isPackaged: true, resourcesPath: join('C:', 'App', 'resources'), appPath: 'X' })).toBe(
      join('C:', 'App', 'resources', 'toast-icons'),
    );
    expect(devDir).toBe(join(repo, 'build', 'toast-icons'));
  });

  it('all six PNGs exist in the repo and are real PNG files', () => {
    for (const a of ['read', 'archive', 'delete']) {
      for (const t of ['light', 'dark']) {
        const p = join(devDir, `${a}-${t}.png`);
        expect(existsSync(p), p).toBe(true);
        expect(readFileSync(p).subarray(1, 4).toString()).toBe('PNG');
      }
    }
  });

  it('picks the dark variant (white glyph) for a dark toast and the light one otherwise', () => {
    const dark = resolveToastIcons({ dir: devDir, dark: true, exists: existsSync });
    const light = resolveToastIcons({ dir: devDir, dark: false, exists: existsSync });
    expect(dark.read).toBe(join(devDir, 'read-dark.png'));
    expect(light.delete).toBe(join(devDir, 'delete-light.png'));
  });

  it('leaves out an icon whose file is missing', () => {
    const icons = resolveToastIcons({ dir: devDir, dark: false, exists: (p) => p.endsWith('archive-light.png') });
    expect(icons).toEqual({ archive: join(devDir, 'archive-light.png') });
  });
});

describe('toast XML with button icons', () => {
  it('has an absolute file:/// imageUri on every button, pointing to an existing file', () => {
    const buttonIcons = resolveToastIcons({ dir: devDir, dark: false, exists: existsSync });
    const xml = buildToastXml({ title: 'T', lines: ['a'], silent: false, context: ctx, buttons, buttonIcons });
    const uris = [...xml.matchAll(/imageUri="([^"]+)"/g)].map((m) => m[1]!);
    expect(uris).toHaveLength(3);
    for (const u of uris) {
      expect(u.startsWith('file:///')).toBe(true);
      expect(u).not.toContain('\\');
      const path = decodeURI(u.slice('file:///'.length));
      expect(existsSync(path), path).toBe(true);
    }
    expect(uris[0]).toContain('read-light.png');
    expect(xml).not.toContain('buttonStyle');
    expect(xml).not.toContain('hint-toolTip');
  });

  it('uses the white-glyph files for a dark toast', () => {
    const buttonIcons = resolveToastIcons({ dir: devDir, dark: true, exists: existsSync });
    const xml = buildToastXml({ title: 'T', lines: [], silent: false, context: ctx, buttons, buttonIcons });
    expect([...xml.matchAll(/imageUri="[^"]*-(dark|light)\.png"/g)].map((m) => m[1])).toEqual(['dark', 'dark', 'dark']);
  });

  it('encodes a path with spaces (user names), then escapes the XML', () => {
    const p = 'C:\\Users\\Ann Lee & Co\\AppData\\Local\\Programs\\Letterdock\\resources\\toast-icons\\read-light.png';
    expect(fileUri(p)).toBe('file:///C:/Users/Ann%20Lee%20&%20Co/AppData/Local/Programs/Letterdock/resources/toast-icons/read-light.png');
    const xml = buildToastXml({ title: 'T', lines: [], silent: false, context: ctx, buttons, buttonIcons: { read: p } });
    expect(xml).toContain('imageUri="file:///C:/Users/Ann%20Lee%20&amp;%20Co/');
    expect(fileUri('C:\\a#b\\c?d.png')).toBe('file:///C:/a%23b/c%3Fd.png');
  });

  it('falls back to text-only buttons when the icon files are missing', () => {
    const buttonIcons = resolveToastIcons({ dir: devDir, dark: false, exists: () => false });
    const xml = buildToastXml({ title: 'T', lines: ['x'], silent: false, context: ctx, buttons, buttonIcons });
    expect(xml).not.toContain('imageUri');
    expect(xml.match(/<action /g)).toHaveLength(3);
    expect([...xml.matchAll(/<action content="([^"]+)"/g)].map((m) => m[1])).toEqual(['Mark as read', 'Archive', 'Delete']);
  });

  it('writes every line as its own <text>', () => {
    const xml = buildToastXml({ title: 'Ann', lines: ['Subject', 'Preview'], silent: false, context: ctx, buttons: [] });
    expect([...xml.matchAll(/<text>([^<]*)<\/text>/g)].map((m) => m[1])).toEqual(['Ann', 'Subject', 'Preview']);
  });
});

describe('toast text lines', () => {
  it('removes a leading copy of the subject from the snippet', () => {
    expect(previewLine('Your invoice', 'Your invoice - Please find attached')).toBe('Please find attached');
    expect(previewLine('Hello', 'Hello: hi there')).toBe('hi there');
    expect(previewLine('Hello', 'Hello \u2014 hi there')).toBe('hi there');
  });
  it('ignores case and spaces when comparing', () => {
    expect(previewLine('Weekly  Report', 'weekly report   \u2013  numbers inside')).toBe('numbers inside');
    expect(previewLine('A B', 'a\n b: c')).toBe('c');
  });
  it('skips the line when the snippet equals the subject or nothing is left', () => {
    expect(mailLines('Same', 'same')).toEqual(['Same']);
    expect(mailLines('Same', 'Same - ')).toEqual(['Same']);
    expect(mailLines('Subject', '')).toEqual(['Subject']);
    expect(mailLines('Subject', '   ')).toEqual(['Subject']);
  });
  it('keeps a snippet that does not start with the subject', () => {
    expect(mailLines('Invoice', 'Dear Ann, here is the bill')).toEqual(['Invoice', 'Dear Ann, here is the bill']);
  });
  it('uses a placeholder for an empty subject and keeps the snippet whole', () => {
    expect(mailLines('', 'some text')).toEqual(['(no subject)', 'some text']);
  });
  it('cuts a long line at a word boundary and adds an ellipsis, never mid-word', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const c = capLine(long);
    const body = c.slice(0, -1);
    expect(c.length).toBeLessThanOrEqual(160);
    expect(c.endsWith('\u2026')).toBe(true);
    expect(long.startsWith(body)).toBe(true);
    expect(long.charAt(body.length)).toBe(' '); // the cut sits right before a space
    expect(capLine('short')).toBe('short');
    // one huge word with no space: hard cut
    expect(capLine('x'.repeat(500)).length).toBe(160);
  });
});

function header(over: Partial<MessageHeader> = {}): MessageHeader {
  return {
    id: 1, accountId: 'a1', folderId: 1, uid: 1, messageIdHeader: '<1@x>', subject: 'Report', from: { name: 'Ann', address: 'a@x.com' },
    to: [], cc: [], date: 0, snippet: 'Report - details', seen: false, flagged: false, answered: false, draft: false,
    hasAttachments: false, size: 1, bodyCached: false, ...over,
  };
}

function setup(sound = true, enabled = true, focused = false) {
  const toasts: ToastSpec[] = [];
  let timer: (() => void) | undefined;
  const n = new Notifier({
    show: (t) => toasts.push(t),
    settings: () => ({ ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, sound, enabled } }),
    isMainFocused: () => focused,
    accountName: async () => 'Work',
    focusMain: vi.fn(),
    setTimer: (fn) => void (timer = fn),
  });
  return {
    n,
    toasts,
    fire: async () => {
      timer?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('Notifier lines', () => {
  it('shows sender, subject and a de-duplicated preview as separate lines', async () => {
    const a = setup();
    a.n.newMail('a1', [header()]);
    await a.fire();
    expect(a.toasts[0]).toMatchObject({ title: 'Ann', lines: ['Report', 'details'] });
  });
  it('snooze-return toast: sender and subject lines, capped at a word boundary', () => {
    const a = setup();
    const subject = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    a.n.snoozeReturned('a1', [header({ subject })]);
    const lines = a.toasts[0]!.lines;
    expect(lines[0]).toBe('Ann');
    expect(lines[1]!.length).toBeLessThanOrEqual(160);
    expect(lines[1]!.endsWith('\u2026')).toBe(true);
  });
});

describe('test notification', () => {
  it('shows a sample single-message toast with all three buttons and the test context', () => {
    const a = setup();
    a.n.showTest();
    expect(a.toasts).toHaveLength(1);
    expect(a.toasts[0]).toMatchObject({
      title: 'Letterdock',
      lines: ['This is a test notification', 'Your buttons and icons look like this.'],
      silent: false,
      context: TEST_TOAST_CONTEXT,
    });
    expect(a.toasts[0]!.buttons?.map((b) => b.action)).toEqual(['read', 'archive', 'delete']);
  });
  it('follows the sound setting, and ignores "Show notifications" and window focus', () => {
    const a = setup(false, false, true);
    a.n.showTest();
    expect(a.toasts).toHaveLength(1);
    expect(a.toasts[0]!.silent).toBe(true);
  });
  it('pressing anything on it does nothing to real mail', async () => {
    const engine = vi.fn();
    const openMessage = vi.fn();
    const sendToMain = vi.fn();
    const showPlain = vi.fn();
    const d = { engine: engine as never, mainVisible: () => true, sendToMain, openMessage, showPlain };
    for (const action of ['open', 'read', 'archive', 'delete'] as const) {
      await onToastActivation(d, { arguments: encodeActivationArgs(action, TEST_TOAST_CONTEXT), type: 'action' });
    }
    expect(engine).not.toHaveBeenCalled();
    expect(openMessage).not.toHaveBeenCalled();
    expect(sendToMain).not.toHaveBeenCalled();
    expect(showPlain).not.toHaveBeenCalled();
  });
  it('the IPC channel is a main channel without arguments', () => {
    expect(MAIN_CHANNELS).toContain('notifications.test');
    expect(schemas['notifications.test']).toBeDefined();
  });
});
