// Channels between main and the engine that the renderer never sees.
import type { AppSettings, DraftAttachment } from './ipc';

export type Credential =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; accessToken: string; expiresAt: number };

export interface SecretRecord {
  password?: string;
  /** OAuth (Microsoft). Never leave main except the short-lived access token. */
  refreshToken?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  oauthProvider?: 'microsoft';
}

/** What an unfinished or finished OAuth sign-in gives the engine (no refresh token). */
export interface OAuthSessionInfo {
  email: string;
  accessToken: string;
  expiresAt: number;
}

/** Engine asks main (main owns safeStorage). */
export interface EngineToMainMethods {
  'secrets.getCredential': {
    req: { accountId: string; forceRefresh?: boolean };
    res: Credential;
  };
  'secrets.set': { req: { accountId: string; secret: SecretRecord }; res: void };
  'secrets.delete': { req: { accountId: string }; res: void };
  /** Look at a finished OAuth sign-in (used by accounts.test). Does not consume it. */
  'secrets.peekOAuthSession': { req: { sessionId: string }; res: OAuthSessionInfo };
  /** Move a finished OAuth sign-in's tokens under the new account id. Consumes the session. */
  'secrets.adoptOAuthSession': {
    req: { sessionId: string; accountId: string };
    res: OAuthSessionInfo;
  };
}

export interface EngineInit {
  dataDir: string;
  settings: AppSettings;
  appVersion: string;
  /** Test/dev hook: override better-sqlite3 native binding path. */
  nativeBinding?: string;
}

export interface PreparedAttachment {
  path: string;
  filename: string;
  size: number;
  contentType: string;
}

/** Main asks the engine (not in the public contract). */
export interface MainToEngineMethods {
  'engine.init': { req: EngineInit; res: void };
  'engine.settings': { req: AppSettings; res: void };
  'attachments.prepare': { req: { attachmentId: number }; res: PreparedAttachment };
  /** The raw message (RFC 822 bytes) and its subject, for "Save as .eml". Needs a connection. */
  'messages.sourceBytes': { req: { messageId: number }; res: { data: Uint8Array; subject: string } };
  /** Files picked in the native dialog: the engine copies them and returns opaque tokens. */
  'attachments.register': {
    req: { files: { path: string; filename: string; contentType: string }[] };
    res: DraftAttachment[];
  };
  /** Reconnect an account after its OAuth tokens were renewed. */
  'accounts.reconnect': { req: { accountId: string }; res: void };
  /** The user unsubscribed (main did the request): remember it. */
  'unsubscribe.record': {
    req: { messageId: number; method: 'one-click' | 'mailto' | 'page' };
    res: void;
  };
  /** The real addresses behind an unsubscribe message. Main only; the renderer never gets the URLs. */
  'unsubscribe.targets': {
    req: { messageId: number };
    res: {
      auth: 'verified' | 'unknown' | 'failed';
      oneClickUrl: string | null;
      pageUrl: string | null;
      mailto: { address: string; subject: string; body: string } | null;
    };
  };
  /** Send the unsubscribe email from the receiving account (normal send path, no undo delay). */
  'unsubscribe.sendMailto': {
    req: { messageId: number; address: string; subject: string; body: string };
    res: void;
  };
  /** A button on a notification was pressed (Mark as read / Archive / Delete). */
  'notifications.action': {
    req: { accountId: string; messageId: number; action: 'read' | 'archive' | 'delete' };
    res: { done: boolean; undoToken?: string };
  };
  /** A .eml file read by main (3.14): the engine parses it and keeps the message under `token`. Rejects INVALID_INPUT with `details` = an EmlErrorCode. */
  'eml.open': {
    req: { token: string; data: Uint8Array; fileName: string; filePath: string; mtimeMs: number };
    res: { subject: string };
  };
  /** The window of this file closed: forget the message. */
  'eml.close': { req: { token: string }; res: void };
  /** One attachment of a file message (bytes), for "Save". */
  'eml.attachment': {
    req: { token: string; attachmentId: number };
    res: { filename: string; contentType: string; data: Uint8Array };
  };
  /** All non-inline attachments of a file message, for "Save all". */
  'eml.attachments': {
    req: { token: string };
    res: { filename: string; contentType: string; data: Uint8Array }[];
  };
  /** The PC woke up from sleep or was unlocked: check the scheduled messages again. */
  'scheduled.recheck': { req: { reason: 'resume' | 'unlock' }; res: void };
  /** The PC switched between battery and mains power. On battery the background download skips the backfill. */
  'system.powerChanged': { req: { onBattery: boolean }; res: void };
}
