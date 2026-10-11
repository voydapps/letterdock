// "Mute in All inboxes": keep an account's mail in its own folders but out of All inboxes, Unread and Flagged
// (DESIGN-SPEC 2.5, Account.inUnified). The lists, counts and sidebar follow from the engine events.
import type { Account } from '../../../shared/ipc';
import { call } from './api';
import { reportActionError, toast } from '../store/toasts';

export function muteMenuLabel(a: Pick<Account, 'inUnified'>): string {
  return a.inUnified ? 'Mute in All inboxes' : 'Show in All inboxes';
}

/** True when the engine accepted the change; a failure shows the usual error toast and returns false. */
function setInUnified(accountId: string, inUnified: boolean): Promise<boolean> {
  return call('accounts.update', { accountId, patch: { inUnified } }).then(
    () => true,
    (e) => {
      reportActionError(e);
      return false;
    },
  );
}

/** Flip the setting and offer Undo in a toast. */
export async function toggleAccountMute(a: Pick<Account, 'id' | 'inUnified'>): Promise<void> {
  const next = !a.inUnified;
  if (!(await setInUnified(a.id, next))) return;
  toast(next ? 'Account shown in All inboxes' : 'Account muted in All inboxes', {
    duration: 6000,
    actionLabel: 'Undo',
    onAction: () => void setInUnified(a.id, !next),
  });
}
