// Windows notifications for new mail and sign-in problems (ARCHITECTURE section 8).
// Pure logic: Electron's Notification and the window are injected, so it can be tested.
import type { AppSettings, MessageHeader, MessageId } from '../shared/ipc';
import { TEST_TOAST_CONTEXT } from './toast';
import { capLine, mailLines } from './toastText';

export interface ToastSpec {
  title: string;
  /** Lines under the title, each shown on its own row. */
  lines: string[];
  silent: boolean;
  onClick: () => void;
  /**
   * Notification for exactly ONE message (DESIGN-SPEC 3.13.3): what the buttons act on, and the
   * buttons to show. The shell turns this into toast XML; without it, a plain notification is shown.
   */
  context?: { accountId: string; messageId: number };
  buttons?: { action: 'read' | 'archive' | 'delete'; label: string }[];
}

export interface NotifierDeps {
  show: (t: ToastSpec) => void;
  settings: () => AppSettings;
  /** True when the main window is on screen and focused: no toast then. */
  isMainFocused: () => boolean;
  accountName: (accountId: string) => Promise<string>;
  /** Bring the app to the front; open this message if given. */
  focusMain: (messageId?: MessageId) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
  /** Gather a burst of mail for this long before showing anything. */
  burstMs?: number;
  /** More than this many messages from one burst become a single toast. */
  groupAbove?: number;
}

const AUTH_THROTTLE_MS = 24 * 3600 * 1000;
const MAX_REMEMBERED = 5000;

export class Notifier {
  private buffers = new Map<string, MessageHeader[]>();
  private canArchive = new Map<string, boolean>();
  private shown = new Set<MessageId>();
  private lastAuth = new Map<string, number>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly now: () => number;

  constructor(private readonly d: NotifierDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.now = d.now ?? (() => Date.now());
  }

  private allowed(accountId: string): boolean {
    const n = this.d.settings().notifications;
    return n.enabled && !n.mutedAccountIds.includes(accountId);
  }

  /** Engine event `notify:newMail`. */
  newMail(accountId: string, messages: MessageHeader[], archiveAvailable = false): void {
    if (!this.allowed(accountId) || this.d.isMainFocused()) return;
    this.canArchive.set(accountId, archiveAvailable);
    const fresh = messages.filter((m) => !this.shown.has(m.id) && !m.seen);
    if (fresh.length === 0) return;
    for (const m of fresh) {
      this.shown.add(m.id);
      if (this.shown.size > MAX_REMEMBERED) this.shown.delete(this.shown.values().next().value!);
    }
    const buf = this.buffers.get(accountId);
    if (buf) {
      buf.push(...fresh);
      return;
    }
    this.buffers.set(accountId, [...fresh]);
    this.setTimer(() => void this.flush(accountId), this.d.burstMs ?? 2500);
  }

  private async flush(accountId: string): Promise<void> {
    const batch = this.buffers.get(accountId) ?? [];
    this.buffers.delete(accountId);
    if (batch.length === 0 || !this.allowed(accountId)) return;
    const name = await this.d.accountName(accountId).catch(() => 'your account');
    const prefs = this.d.settings().notifications;
    const silent = !prefs.sound;
    if (batch.length > (this.d.groupAbove ?? 3)) {
      this.d.show({
        title: `${batch.length} new messages`,
        lines: [`in ${name}`],
        silent,
        onClick: () => this.d.focusMain(),
      });
      return;
    }
    // Buttons (Mark as read / Archive / Delete) only on a notification for one message, if the setting is on.
    // Mark as read and Archive also show in the "New mail only" privacy mode: they reveal nothing.
    // Delete does not: the user cannot see which message it is (DESIGN-SPEC 3.13.3).
    const withButtons = this.d.settings().notifyActions !== false;
    const buttons = (): NonNullable<ToastSpec['buttons']> => [
      { action: 'read', label: 'Mark as read' },
      ...(this.canArchive.get(accountId) ? [{ action: 'archive' as const, label: 'Archive' }] : []),
      ...(prefs.showPreview ? [{ action: 'delete' as const, label: 'Delete' }] : []),
    ];
    for (const m of batch) {
      const sender = m.from?.name || m.from?.address || 'Unknown sender';
      const extra = withButtons ? { context: { accountId, messageId: m.id }, buttons: buttons() } : {};
      this.d.show(
        prefs.showPreview
          ? {
              title: capLine(sender),
              lines: mailLines(m.subject, m.snippet),
              silent,
              onClick: () => this.d.focusMain(m.id),
              ...extra,
            }
          : { title: 'New mail', lines: [name], silent, onClick: () => this.d.focusMain(m.id), ...extra },
      );
    }
  }

  /**
   * Engine event `snooze:returned` (DESIGN-SPEC 3.13.2): one notification for the whole batch.
   * Honors "Show notifications", muted accounts and "Notify when snoozed mail comes back".
   * Never has buttons.
   */
  snoozeReturned(accountId: string, messages: MessageHeader[]): void {
    const s = this.d.settings();
    if (messages.length === 0 || !this.allowed(accountId) || s.notifySnoozeReturn === false) return;
    if (this.d.isMainFocused()) return;
    const silent = !s.notifications.sound;
    const m = messages[0]!;
    if (messages.length === 1 && s.notifications.showPreview) {
      const sender = m.from?.name || m.from?.address || 'Unknown sender';
      this.d.show({
        title: 'Snoozed mail is back',
        lines: [capLine(sender), capLine(m.subject || '(no subject)')],
        silent,
        onClick: () => this.d.focusMain(m.id),
      });
      return;
    }
    this.d.show({
      title: 'Snoozed mail is back',
      lines: [messages.length === 1 ? 'A message is back in your Inbox' : `${messages.length} messages are back in your Inbox`],
      silent,
      onClick: () => this.d.focusMain(messages.length === 1 ? m.id : undefined),
    });
  }

  /**
   * "Show a test notification" (Settings > Notifications). A made-up single-message toast with all
   * three buttons, so the user can see how buttons and icons look. It ignores "Show notifications"
   * and the focus check (the button is pressed inside the app), but follows the sound setting.
   * Its context belongs to no real message: pressing anything on it does nothing.
   */
  showTest(): void {
    this.d.show({
      title: 'Letterdock',
      lines: ['This is a test notification', 'Your buttons and icons look like this.'],
      silent: !this.d.settings().notifications.sound,
      onClick: () => undefined,
      context: TEST_TOAST_CONTEXT,
      buttons: [
        { action: 'read', label: 'Mark as read' },
        { action: 'archive', label: 'Archive' },
        { action: 'delete', label: 'Delete' },
      ],
    });
  }

  /** Engine event `account:authRequired`: at most one toast per account per 24 hours. */
  async authRequired(accountId: string): Promise<void> {
    if (!this.d.settings().notifications.enabled) return;
    const last = this.lastAuth.get(accountId);
    const now = this.now();
    if (last !== undefined && now - last < AUTH_THROTTLE_MS) return;
    this.lastAuth.set(accountId, now);
    const name = await this.d.accountName(accountId).catch(() => 'An account');
    this.d.show({
      title: `${name} needs you to sign in again`,
      lines: ['Open Letterdock to fix it.'],
      silent: !this.d.settings().notifications.sound,
      onClick: () => this.d.focusMain(),
    });
  }
}
