// Entry of the message window (viewer.html). Main opens it with `#msg=<messageId>` (mailbox mail),
// `#eml=<token>` (a message from a .eml file) or `#emlerror=<code>` (the small error window) in the URL.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ViewerApp } from './features/viewer/ViewerApp';
import { readEmlErrorHash, type EmlErrorItem } from '../../shared/emlErrors';
import { EmlErrorApp, EmlViewerApp } from './features/viewer/EmlViewerApp';
import './styles/app.css';
import './styles/mail-actions.css';
import './styles/light.css';

/** Reads the message id main put in the URL hash. Returns null when it is missing or invalid. */
export function readViewerMessageId(hash: string = location.hash): number | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('msg');
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The opaque token of an opened .eml file (`#eml=<token>`), or null when missing or odd. */
export function readViewerEmlToken(hash: string = location.hash): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('eml');
  return raw !== null && /^[A-Za-z0-9-]{8,80}$/.test(raw) ? raw : null;
}

/** The files listed by the small error window (`#emlerror=<code>&emlfile=<name>`, once per file). */
export function readViewerEmlErrors(hash: string = location.hash): EmlErrorItem[] {
  return readEmlErrorHash(hash);
}

async function start(): Promise<void> {
  // Dev only: ?fake=1 in a plain browser uses the fake backend (tree-shaken from production builds).
  if (import.meta.env.DEV && !('api' in window) && location.search.includes('fake')) {
    const { installFakeApi } = await import('./dev/fakeApi');
    installFakeApi();
  }
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const app = params.has('emlerror') ? (
    <EmlErrorApp items={readViewerEmlErrors()} />
  ) : params.has('eml') ? (
    <EmlViewerApp token={readViewerEmlToken()} />
  ) : (
    <ViewerApp messageId={readViewerMessageId()} />
  );
  createRoot(document.getElementById('root')!).render(<StrictMode>{app}</StrictMode>);
}

void start();
