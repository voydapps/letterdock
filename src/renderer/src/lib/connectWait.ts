import { useEffect, useState } from 'react';
import type { AccountId, AccountStatus } from '../../../shared/ipc';
import { useApp } from '../store/app';

/** How long a dialog waits for the connection before it closes and leaves the rest to the status bar. */
export const CONNECT_WAIT_MS = 15_000;

export type ConnectOutcome = 'waiting' | 'online' | 'offline' | 'auth_failed' | 'timeout';

/**
 * What a "new password" dialog should say once the credentials are saved.
 * `baseline` is the status the account had when the save returned. A sign-in problem only counts
 * as "refused again" when it is a newer status than that one (the old one is still on screen).
 */
export function connectOutcome(status: AccountStatus | undefined, baseline: AccountStatus | undefined): ConnectOutcome {
  if (!status) return 'waiting';
  switch (status.state) {
    case 'online':
    case 'syncing':
      return 'online';
    case 'offline':
      return 'offline';
    case 'auth_failed':
    case 'needs_reauth':
      return status === baseline ? 'waiting' : 'auth_failed';
    default:
      return 'waiting';
  }
}

/** Follows the account after its credentials were saved. Pass `baseline = null` before the save. */
export function useConnectOutcome(accountId: AccountId, baseline: AccountStatus | undefined | null): ConnectOutcome {
  const status = useApp((s) => s.statuses[accountId]);
  const [timedOut, setTimedOut] = useState(false);
  const started = baseline !== null;
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => setTimedOut(true), CONNECT_WAIT_MS);
    return () => {
      clearTimeout(t);
      setTimedOut(false);
    };
  }, [started]);
  if (!started) return 'waiting';
  const out = connectOutcome(status, baseline);
  return out === 'waiting' && timedOut ? 'timeout' : out;
}

export const CONNECT_TEXT = {
  connecting: 'Password saved. Connecting...',
  offline: "Saved. Letterdock will connect when you're back online.",
  timeout: 'Saved. Still connecting - see the status bar.',
  refused: 'The server rejected the password. Check it and try again.',
} as const;
