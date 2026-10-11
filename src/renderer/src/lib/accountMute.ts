// "Mute in All inboxes": keep an account's mail in its own folders but out of All inboxes, Unread and Flagged
// (DESIGN-SPEC 3.x, Account.inUnified). The lists, counts and sidebar follow from the engine events.
import type { Account } from '../../../shared/ipc';
import { call } from './api';
import { reportActionError, toast } from '../store/toasts';

export function muteMenuLabel(a: Pick<Account, 'inUnified'>): string {
  return a.inUnified ? 'Mute in All inboxes' : 'Show in All inboxes';
}

function setInUnified(accountId: string, inUnified: boolean): Promise<void> {
  return call('accounts.update', { accountId, patch: { inUnified } }).then(
    () => undefined,
    (e) => reportActionError(e),
  );
}

/** Flip the setting and offer Undo in a toast. */
export async function toggleAccountMute(a: Pick<Account, 'id' | 'inUnified'>): Promise<void> {
  const next = !a.inUnified;
  await setInUnified(a.id, next);
  toast(next ? 'Account shown in All inboxes' : 'Account muted in All inboxes', {
    duration: 6000,
    actionLabel: 'Undo',
    onAction: () => void setInUnified(a.id, !next),
  });
}
