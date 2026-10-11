// Request checks of the .eml channels (src/main/ipcSchemas.ts) and who answers them (src/shared/channels.ts).
import { describe, expect, it } from 'vitest';
import { isKnownChannel, schemas } from '../../src/main/ipcSchemas';
import { isMainChannel } from '../../src/shared/channels';

describe('.eml channels', () => {
  it('main answers the ones that need files, dialogs and windows; the engine answers the rest', () => {
    for (const c of ['eml.pickFiles', 'eml.openPaths', 'eml.saveAttachment', 'eml.saveAllAttachments', 'eml.showInFolder', 'eml.print']) {
      expect(isKnownChannel(c), c).toBe(true);
      expect(isMainChannel(c), c).toBe(true);
    }
    for (const c of ['eml.get', 'eml.cidData', 'eml.rawSource', 'eml.compose']) {
      expect(isKnownChannel(c), c).toBe(true);
      expect(isMainChannel(c), c).toBe(false);
    }
  });

  it('the calls from main to the engine are not callable by a window', () => {
    for (const c of ['eml.open', 'eml.close', 'eml.attachment', 'eml.attachments']) {
      expect(isKnownChannel(c), c).toBe(false);
    }
  });

  it('a token is an opaque id; a path or odd text is never accepted as one', () => {
    expect(schemas['eml.get'].safeParse({ token: 'abcd-1234-ef' }).success).toBe(true);
    expect(schemas['eml.get'].safeParse({ token: '3f2b8c1e-5d4a-4b7e-9c11-0a1b2c3d4e5f' }).success).toBe(true);
    for (const token of ['C:\\x\\m.eml', '../a', '', 'short', 'a'.repeat(81), 'ok ok ok ok', 'a/b/c/d/e/f/g']) {
      expect(schemas['eml.get'].safeParse({ token }).success, token).toBe(false);
    }
    for (const c of ['eml.cidData', 'eml.rawSource', 'eml.compose', 'eml.showInFolder', 'eml.saveAllAttachments', 'eml.print'] as const) {
      expect(schemas[c].safeParse({ token: 'C:\\x\\m.eml', contentId: 'x', mode: 'reply' }).success, c).toBe(false);
    }
  });

  it('other fields', () => {
    expect(schemas['eml.openPaths'].safeParse({ paths: [] }).success).toBe(false);
    expect(schemas['eml.openPaths'].safeParse({ paths: ['C:\\a.eml'] }).success).toBe(true);
    expect(schemas['eml.openPaths'].safeParse({ paths: Array.from({ length: 101 }, () => 'C:\\a.eml') }).success).toBe(false);
    expect(schemas['eml.compose'].safeParse({ token: 'abcd-1234-ef', mode: 'new' }).success).toBe(false);
    expect(schemas['eml.compose'].safeParse({ token: 'abcd-1234-ef', mode: 'forward' }).success).toBe(true);
    expect(schemas['eml.saveAttachment'].safeParse({ token: 'abcd-1234-ef', attachmentId: 0 }).success).toBe(false);
    expect(schemas['eml.saveAttachment'].safeParse({ token: 'abcd-1234-ef', attachmentId: 2 }).success).toBe(true);
    expect(schemas['eml.pickFiles'].safeParse(undefined).success).toBe(true);
  });
});
