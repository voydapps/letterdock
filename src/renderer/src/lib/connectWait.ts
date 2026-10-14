import { useEffect, useState } from 'react';
import type { AccountId, AccountStatus } from '../../../shared/ipc';
import { useApp } from '../store/app';

/** How long a dialog waits for the connection before it closes and leaves the rest to the status bar. */
export const CONNECT_WAIT_MS = 15_000;

export type ConnectOutcome = 'waiting' | 'online' | 'offline' | 'auth_failed' | 'timeout';

const isAuth = (st: AccountStatus | undefined) => st?.state === 'auth_failed' || st?.state === 'needs_reauth';

/**
 * What a "new password" dialog should say once the credentials are saved.
 * A sign-in problem only counts as "refused again" after the account moved on (connecting, retrying...)
 * since the save. Before that, the old "sign in again" status may still be on screen, even if the
 * store replaced the object, so it says nothing new.
 */
export function connectOutcome(status: AccountStatus | undefined, progressed: boolean): ConnectOutcome {
  if (!status) return 'waiting';
  switch (status.state) {
    case 'online':
    case 'syncing':
      return 'online';
    case 'offline':
      return 'offline';
    case 'auth_failed':
    case 'needs_reauth':
      return progressed ? 'auth_failed' : 'waiting';
    default:
      return 'waiting';
  }
}

/** Follows the account after its credentials were saved. Pass `started = false` before the save. */
export function useConnectOutcome(accountId: AccountId, started: boolean): ConnectOutcome {
  const status = useApp((s) => s.statuses[accountId]);
  const [timedOut, setTimedOut] = useState(false);
  const [progressed, setProgressed] = useState(false);
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => setTimedOut(true), CONNECT_WAIT_MS);
    // A state change after the save (not just a new copy of the old one) means the engine moved on.
    const unsub = useApp.subscribe((s, prev) => {
      const now = s.statuses[accountId];
      if (now && !isAuth(now) && now !== prev.statuses[accountId]) setProgressed(true);
    });
    return () => {
      clearTimeout(t);
      unsub();
      setTimedOut(false);
      setProgressed(false);
    };
  }, [started, accountId]);
  if (!started) return 'waiting';
  const out = connectOutcome(status, progressed);
  return out === 'waiting' && timedOut ? 'timeout' : out;
}

export const CONNECT_TEXT = {
  connecting: 'Password saved. Connecting...',
  offline: "Saved. Letterdock will connect when you're back online.",
  timeout: 'Saved. Still connecting - see the status bar.',
  refused: 'The server rejected the password. Check it and try again.',
} as const;
