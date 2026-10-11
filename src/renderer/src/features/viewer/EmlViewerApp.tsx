// Root of the message window when it shows an .eml file (DESIGN-SPEC 3.14). Main opens it with
// `#eml=<token>`; the path is never in the URL. Same title bar, header, body and attachments as a
// mailbox message (MessageView), in "file mode": everything asks by token.
// Also the small error window (`#emlerror=<code>`) for an app that was started by a file it could not open.
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { AppError, EmlMessage } from '../../../../shared/ipc';
import { EML_ERROR_TEXT, isEmlErrorCode } from '../../../../shared/emlErrors';
import { Banner, Button, MenuHost, ToastHost, useMenu } from '../../components/ui';
import { ContactPopoverHost } from '../../components/ContactPopover';
import { MessageView } from '../reading/ReadingPane';
import { FileModeContext } from '../reading/fileMode';
import { useApp, activePreset } from '../../store/app';
import { useList } from '../../store/list';
import { useThemeEffect } from '../../lib/hooks';
import { asAppError, call } from '../../lib/api';
import { composeFromEml } from '../../lib/actions';
import { printOpenMessage } from '../../lib/print';
import { matchShortcut, isTypingTarget } from '../../lib/shortcuts';
import { toastError } from '../../store/toasts';
import appIcon from '../../../../../build/icon-small.svg';

type Load = { status: 'loading' } | { status: 'error'; error: AppError } | { status: 'ready'; message: EmlMessage };

const BAD_LINK: AppError = { code: 'INVALID_INPUT', message: EML_ERROR_TEXT.unreadable, retryable: false };

/** True once `ms` have passed. The loading skeleton waits 300 ms, so a quick open never flashes it (3.14.6). */
function useAfter(ms: number, active: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return;
    const h = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(h);
  }, [ms, active]);
  return active && late;
}

/** A file name with the end kept visible: the start shrinks with "..." and the last characters (with the extension) stay. */
export function MiddleEllipsis({ text, tail = 10 }: { text: string; tail?: number }) {
  const cut = text.length > tail * 2 ? text.length - tail : 0;
  return (
    <span className="mid">
      <span className="mid-head">{cut ? text.slice(0, cut) : text}</span>
      {cut ? <span className="mid-tail">{text.slice(cut)}</span> : null}
    </span>
  );
}

/** Placeholder shapes of a message while it loads: header lines and some body lines. */
function LoadingSkeleton() {
  return (
    <div className="vskel" aria-hidden="true" data-eml-skeleton>
      <div className="skel" style={{ height: 22, width: '55%' }} />
      <div className="skel" style={{ height: 14, width: '35%' }} />
      <div className="skel" style={{ height: 14, width: '45%' }} />
      <div className="mbody-skel">
        <div className="skel" style={{ height: 12, width: '92%' }} />
        <div className="skel" style={{ height: 12, width: '86%' }} />
        <div className="skel" style={{ height: 12, width: '90%' }} />
        <div className="skel" style={{ height: 12, width: '60%' }} />
      </div>
    </div>
  );
}

export function EmlViewerApp({ token }: { token: string | null }) {
  useThemeEffect();
  const [load, setLoad] = useState<Load>(token === null ? { status: 'error', error: BAD_LINK } : { status: 'loading' });

  useEffect(() => {
    if (token === null) return;
    let alive = true;
    void (async () => {
      try {
        // Accounts and settings: the Reply buttons need to know if there is an account.
        const [accounts, statuses, folders, settings] = await Promise.all([
          call('accounts.list'),
          call('accounts.statuses'),
          call('folders.list', {}),
          call('settings.get'),
        ]);
        useApp.setState({
          accounts,
          statuses: Object.fromEntries(statuses.map((s) => [s.accountId, s])),
          folders,
          settings,
          loaded: true,
        });
        const message = await call('eml.get', { token });
        if (!alive) return;
        useList.setState({ items: [message.header], selectedIds: [], focusId: null });
        setLoad({ status: 'ready', message });
      } catch (e) {
        if (alive) setLoad({ status: 'error', error: asAppError(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  // The engine restarted: the message in its memory is gone. Say so instead of showing stale buttons.
  useEffect(
    () =>
      window.api.on((e) => {
        useApp.getState().handleEvent(e);
        if (e.type === 'engine:restarted' && token !== null) {
          call('eml.get', { token }).catch((err) => setLoad({ status: 'error', error: asAppError(err) }));
        }
      }),
    [token],
  );

  const showSkeleton = useAfter(300, load.status === 'loading');
  const message = load.status === 'ready' ? load.message : null;
  const subject = message ? message.header.subject || '(no subject)' : null;
  useEffect(() => {
    document.title = subject ? `${subject} - Letterdock` : 'Letterdock';
    document.documentElement.dataset.window = 'message';
  }, [subject]);

  // Focus starts on the message body.
  const ready = load.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    let tries = 0;
    const h = setInterval(() => {
      const el = document.querySelector<HTMLElement>('.mbody iframe, .mbody');
      tries++;
      if (el) {
        el.setAttribute('tabindex', '0');
        el.focus();
      }
      if (el || tries > 30) clearInterval(h);
    }, 100);
    return () => clearInterval(h);
  }, [ready]);

  // Keys (DESIGN-SPEC 3.14.3): Ctrl+P, Ctrl+R, Ctrl+Shift+R, Ctrl+F, Esc / Ctrl+W. Delete, E and H do nothing.
  useEffect(() => {
    if (token === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const sc = matchShortcut(e, activePreset());
      if (!sc) return;
      if (document.querySelector('.modal') || useMenu.getState().menu) return;
      if (isTypingTarget(e.target) && sc.id !== 'back' && sc.id !== 'closeWindow') return;
      const hasAccount = useApp.getState().accounts.length > 0;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (sc.id) {
        case 'back':
        case 'closeWindow':
          return run(() => window.close());
        case 'print':
          return run(() => printOpenMessage(-1));
        case 'reply':
        case 'replyAll':
        case 'forward':
          return run(() => {
            if (!hasAccount) toastError('Add an account to reply.');
            else composeFromEml(token, sc.id as 'reply' | 'replyAll' | 'forward');
          });
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [token]);

  const fileMode = useMemo(() => (token !== null && message ? { token, message } : null), [token, message]);

  let content;
  if (load.status === 'loading') {
    content = (
      <div className="vload vloading" aria-busy="true" aria-label="Loading message">
        {showSkeleton ? <LoadingSkeleton /> : null}
      </div>
    );
  } else if (load.status === 'error') {
    content = (
      <div className="vload">
        <Banner tone="danger" actions={<Button size="sm" onClick={() => window.close()}>Close</Button>}>
          {load.error.message}
        </Banner>
      </div>
    );
  } else {
    content = (
      <FileModeContext.Provider value={fileMode}>
        <div className="rbanner eml-banner" role="status" data-eml-banner>
          <Icon name="info" size={16} className="ic" />
          <div className="eml-name" title={load.message.filePath}>
            <span className="eml-lead">Opened from a file:&nbsp;</span>
            <MiddleEllipsis text={load.message.fileName} />
          </div>
          <button
            type="button"
            className="link"
            onClick={() => void call('eml.showInFolder', { token: token! }).catch((e) => toastError(asAppError(e).message))}
          >
            Show in folder
          </button>
        </div>
        <MessageView key={token} header={load.message.header} windowMode />
      </FileModeContext.Provider>
    );
  }

  return (
    <div className="app vwin">
      <header className="titlebar ctitle vtitle" role="banner">
        <img className="appico" src={appIcon} alt="" aria-hidden="true" draggable={false} />
        <b>{subject ?? 'Message'}</b>
      </header>
      <main className="reading" aria-label="Message" id="pane-reading" style={{ containerType: 'inline-size' }}>
        {content}
      </main>
      <MenuHost />
      <ContactPopoverHost />
      <ToastHost />
    </div>
  );
}

/** The small error window: the app was started by a file that could not be opened (3.14.4). Icon, text, Close. */
export function EmlErrorApp({ code }: { code: string | null }) {
  useThemeEffect();
  const text = isEmlErrorCode(code) ? EML_ERROR_TEXT[code] : EML_ERROR_TEXT.unreadable;
  useEffect(() => {
    document.title = 'Letterdock';
    document.documentElement.dataset.window = 'message';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.ctrlKey && e.key.toLowerCase() === 'w')) window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="app vwin">
      <header className="titlebar ctitle vtitle" role="banner">
        <img className="appico" src={appIcon} alt="" aria-hidden="true" draggable={false} />
        <b>Letterdock</b>
      </header>
      <main className="reading" aria-label="Message file error">
        <div className="vload eml-err" role="alert" data-eml-error>
          <span className="eml-err-ic">
            <Icon name="warn" size={24} />
          </span>
          <p>{text}</p>
          <Button variant="primary" onClick={() => window.close()}>
            Close
          </Button>
        </div>
      </main>
    </div>
  );
}
