// Handlers for channels the main process owns (see shared/channels.ts).
import { copyFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, net, shell } from 'electron';
import { convert as htmlToText } from 'html-to-text';
import type {
  DraftAttachment,
  IpcReq,
  IpcRes,
  MessageBody,
  MessageHeader,
  PrepareComposeReq,
  AppSettings,
  EmlMessage,
  PrintMessageRes,
} from '../shared/ipc';
import type { MainChannel } from '../shared/channels';
import { AppException } from '../shared/errors';
import type { PreparedAttachment } from '../shared/internal';
import { isExecutableName, isSafeExternalUrl } from '../shared/safety';
import { safeFileName } from '../shared/fileName';
import type { EngineHost } from './engineHost';
import type { OAuthService } from './oauth/service';
import type { Logger } from './logger';
import type { AppUpdater } from './updater';
import type { SettingsStore } from './settings';
import type { ImageDiskCache } from './imageCache/store';
import { computeMailtoStatus, DEFAULT_APPS_URI } from './mailto';
import type { EmlOpener } from './emlOpener';
import { saveAttachmentsToFolder } from './emlSave';
import { buildPrintDocument } from './print/printDocument';
import { printDocument, type PrintDeps } from './print/printWindow';
import { SavedPaths, saveEml } from './saveEml';
import { postOneClick } from './unsubscribe/oneClick';
import { runUnsubscribe } from './unsubscribe/run';

type MainHandlers = {
  [C in MainChannel]: (req: IpcReq<C>) => Promise<IpcRes<C>> | IpcRes<C>;
};

export interface HandlerDeps {
  settings: SettingsStore;
  imageCache: ImageDiskCache;
  engine: EngineHost;
  log: Logger;
  updater: Pick<AppUpdater, 'status' | 'check' | 'install'>;
  logsDir: string;
  dbPath: string;
  getWindow: () => BrowserWindow | null;
  oauth: OAuthService;
  /** Opens a compose window for the request. */
  openCompose: (req: PrepareComposeReq) => void;
  /** Opens (or focuses) the message window. */
  openViewer: (messageId: number) => void;
  /** Opens .eml files in message windows (DESIGN-SPEC 3.14). */
  eml: EmlOpener;
  /**
   * Called after a setting was saved: `patch` is the part that changed, or null when the OAuth
   * settings changed. Main applies side effects (login item, log level) and tells every window.
   */
  onSettingsChanged: (patch: Partial<AppSettings> | null) => void;
  print: PrintDeps;
  /**
   * Shows the Undo toast in the main window (event `ui:undoAvailable`). Returns false when there is
   * no main window the user can see.
   */
  showUndoInMain: (e: { label: string; undoToken: string; count: number }) => boolean;
  /** Brings the main window to the front and shows Settings on this page. */
  openSettingsInMain: (section: 'mail', anchor?: 'quick-replies') => boolean;
}

export function createMainHandlers(d: HandlerDeps): MainHandlers {
  async function saveAs(prep: PreparedAttachment): Promise<boolean> {
    const win = d.getWindow();
    const opts = { defaultPath: join(app.getPath('downloads'), prep.filename) };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return false;
    await copyFile(prep.path, res.filePath);
    return true;
  }

  const savedPaths = new SavedPaths();

  async function printMessage(h: MessageHeader, body: MessageBody | null, bodyHtml: string | undefined): Promise<PrintMessageRes> {
    let text = '';
    if (bodyHtml === undefined && body) {
      // No sanitized HTML given: print the plain text (made from the HTML if there is no text part).
      text =
        body.text ??
        (body.html
          ? htmlToText(body.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] })
          : '');
    }
    const html = buildPrintDocument({
      subject: h.subject,
      from: h.from,
      to: h.to,
      cc: h.cc,
      bcc: body?.bcc ?? [],
      attachments: (body?.attachments ?? [])
        .filter((a) => !a.inline)
        .map((a) => ({ filename: a.filename, size: a.size })),
      date: h.date,
      bodyHtml: bodyHtml ?? null,
      text,
    });
    return { printed: await printDocument(html, d.print) };
  }

  return {
    'oauth.getSettings': () => d.settings.getOAuth(),
    'oauth.setSettings': (r) => {
      const next = d.settings.setOAuth(r);
      d.onSettingsChanged(null);
      return next;
    },
    'oauth.start': (r) => d.oauth.start(r),
    'oauth.complete': (r) => d.oauth.complete(r),
    'oauth.cancel': (r) => d.oauth.cancel(r.sessionId),
    'oauth.reauthorize': (r) => d.oauth.reauthorize(r),

    'attachments.open': async (r) => {
      const prep = await d.engine.request<PreparedAttachment>('attachments.prepare', {
        attachmentId: r.attachmentId,
      });
      if (isExecutableName(prep.filename)) {
        const win = d.getWindow();
        const opts = {
          type: 'warning' as const,
          title: 'This file can run programs',
          message: `"${prep.filename}" is a type of file that can run programs on your PC.`,
          detail:
            'Only open it if you trust the sender. You can save it instead and check it first.',
          buttons: ['Save As...', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        };
        const choice = win
          ? await dialog.showMessageBox(win, opts)
          : await dialog.showMessageBox(opts);
        if (choice.response === 0) await saveAs(prep);
        return;
      }
      const err = await shell.openPath(prep.path);
      if (err)
        throw new AppException('INTERNAL', 'Could not open the attachment.', { details: err });
    },
    'attachments.saveAs': async (r) => {
      const prep = await d.engine.request<PreparedAttachment>('attachments.prepare', {
        attachmentId: r.attachmentId,
      });
      return { saved: await saveAs(prep) };
    },

    'compose.openWindow': (r) => d.openCompose(r),
    'message.openWindow': (r) => d.openViewer(r.messageId),
    'message.print': async (r) => {
      const headers = await d.engine.request<MessageHeader[]>('messages.getHeaders', {
        messageIds: [r.messageId],
      });
      const h = headers[0];
      if (!h) throw new AppException('NOT_FOUND', 'Message not found.');
      // The full message gives Bcc and the attachment names. It is cached when the renderer showed it.
      let body: MessageBody | null = null;
      try {
        body = await d.engine.request<MessageBody>('messages.get', { messageId: r.messageId });
      } catch (e) {
        // Without the renderer's HTML we need the body to print anything.
        if (r.bodyHtml === undefined) throw e;
      }
      return printMessage(h, body, r.bodyHtml);
    },
    'eml.print': async (r) => {
      const m = await d.engine.request<EmlMessage>('eml.get', { token: r.token });
      return printMessage(m.header, m.body, r.bodyHtml);
    },
    'eml.pickFiles': async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? d.getWindow();
      const opts = {
        title: 'Open message file',
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [{ name: 'Email message (*.eml)', extensions: ['eml'] }],
      };
      const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || res.filePaths.length === 0) return { opened: 0, total: 0, notice: null, errors: [] };
      return d.eml.openPaths(res.filePaths);
    },
    'eml.openPaths': (r) => d.eml.openPaths(r.paths),
    'eml.saveAttachment': async (r) => {
      const att = await d.engine.request<{ filename: string; data: Uint8Array }>('eml.attachment', {
        token: r.token,
        attachmentId: r.attachmentId,
      });
      const parent = BrowserWindow.getFocusedWindow() ?? d.getWindow();
      const name = safeFileName(att.filename);
      const opts = { defaultPath: join(app.getPath('downloads'), name) };
      const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return { saved: false };
      await writeFile(res.filePath, att.data);
      savedPaths.add(res.filePath);
      return { saved: true };
    },
    'eml.saveAllAttachments': async (r) => {
      const parent = BrowserWindow.getFocusedWindow() ?? d.getWindow();
      const opts = {
        title: 'Choose a folder for the attachments',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory' as const, 'createDirectory' as const],
      };
      const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const folder = res.filePaths[0];
      if (res.canceled || !folder) return { saved: 0 };
      const list = await d.engine.request<{ filename: string; data: Uint8Array }[]>('eml.attachments', {
        token: r.token,
      });
      return { saved: await saveAttachmentsToFolder(folder, list) };
    },
    'eml.showInFolder': (r) => {
      const p = d.eml.pathOf(r.token);
      if (!p) throw new AppException('NOT_FOUND', 'This message file is no longer open.');
      shell.showItemInFolder(p);
    },
    'messages.saveEml': async (r) => {
      const res = await saveEml(
        {
          fetchSource: (messageId) =>
            d.engine.request<{ data: Uint8Array; subject: string }>('messages.sourceBytes', { messageId }),
          defaultDir: () => app.getPath('downloads'),
          chooseFile: async (defaultPath) => {
            // The dialog belongs to whichever window asked (main or the message window).
            const parent = BrowserWindow.getFocusedWindow() ?? d.getWindow();
            const opts = {
              title: 'Save message',
              defaultPath,
              filters: [{ name: 'Email message', extensions: ['eml'] }],
            };
            const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
            return res.canceled || !res.filePath ? null : res.filePath;
          },
          writeFile: (path, data) => writeFile(path, data),
        },
        r.messageId,
      );
      if (res.saved && res.path) savedPaths.add(res.path);
      return res;
    },
    'unsubscribe.run': (r) =>
      runUnsubscribe(
        {
          engine: (channel, payload) => d.engine.request(channel, payload),
          postOneClick: (url) => postOneClick(url),
          openExternal: (url) => shell.openExternal(url),
          isOnline: () => net.isOnline(),
        },
        r,
      ),
    'ui.showUndo': (r) => ({
      delivered: d.showUndoInMain({ label: r.label, undoToken: r.undoToken, count: r.count ?? 0 }),
    }),
    'ui.openSettings': (r) => ({ delivered: d.openSettingsInMain(r.section, r.anchor) }),
    'compose.pickFiles': async () => {
      // The dialog belongs to whichever window asked (main or a compose window).
      const parent = BrowserWindow.getFocusedWindow() ?? d.getWindow();
      const opts = { title: 'Attach files', properties: ['openFile' as const, 'multiSelections' as const] };
      const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || res.filePaths.length === 0) return { attachments: [] };
      const files = res.filePaths.map((path) => ({ path, filename: basename(path), contentType: '' }));
      const attachments = await d.engine.request<DraftAttachment[]>('attachments.register', { files });
      return { attachments };
    },

    'settings.get': () => d.settings.get(),
    'settings.set': async (patch) => {
      const next = d.settings.set(patch);
      // Keeps the native caption buttons and window colors in step with the Theme setting.
      if (patch.theme !== undefined) nativeTheme.themeSource = next.theme;
      if (patch.imageCacheMaxMb !== undefined || patch.imageCacheMaxAgeDays !== undefined) {
        d.imageCache.setMaxBytes(next.imageCacheMaxMb * 1024 * 1024);
        d.imageCache.setMaxAgeDays(next.imageCacheMaxAgeDays);
        void d.imageCache.trim().catch(() => undefined);
      }
      await d.engine.request('engine.settings', next).catch(() => undefined);
      d.onSettingsChanged(patch);
      return next;
    },

    'images.cacheInfo': () => d.imageCache.info(),
    'images.clearCache': () => d.imageCache.clear(),

    'app.openExternal': async (r) => {
      if (!isSafeExternalUrl(r.url)) {
        throw new AppException('INVALID_INPUT', 'Only web and email links can be opened.');
      }
      await shell.openExternal(r.url);
    },
    'app.mailtoStatus': () =>
      computeMailtoStatus({
        isPackaged: app.isPackaged,
        registeredCommand: app.isPackaged && app.isDefaultProtocolClient('mailto'),
        currentHandlerName: app.isPackaged ? app.getApplicationNameForProtocol('mailto:') : '',
        appName: app.getName(),
      }),
    'app.openDefaultAppsSettings': async () => {
      // Fixed address on purpose: never built from input.
      await shell.openExternal(DEFAULT_APPS_URI);
    },
    'app.showItemInFolder': (r) => {
      // Only a file this app saved a moment ago. Never a path from the window.
      if (!savedPaths.has(r.path)) {
        throw new AppException('INVALID_INPUT', 'That file was not saved by Letterdock just now.');
      }
      shell.showItemInFolder(r.path);
    },
    'app.openLogs': async () => {
      await shell.openPath(d.logsDir);
    },
    'app.info': () => ({
      version: app.getVersion(),
      dbPath: d.dbPath,
      electron: process.versions.electron,
    }),
    'log.write': (r) => {
      if (r.level === 'error') d.log.error({ source: 'renderer' }, r.msg);
      else d.log.warn({ source: 'renderer' }, r.msg);
    },

    // Updates from GitHub Releases. status and check never throw: problems are in the status.
    'updates.status': () => d.updater.status(),
    'updates.check': () => d.updater.check(),
    'updates.install': () => d.updater.install(),
  };
}
