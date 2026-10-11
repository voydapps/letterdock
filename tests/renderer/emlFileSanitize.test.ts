// @vitest-environment jsdom
// A message from an .eml file goes through the same sanitizer as mailbox mail (DESIGN-SPEC 3.14.3 / 3.14.5):
// the engine returns the raw HTML, the window sanitizes it, remote images stay blocked, trackers are found.
import { describe, expect, it } from 'vitest';
import { EmlService } from '../../src/engine/messages/emlService';
import { nullLogger } from '../../src/engine/logger';
import { sanitizeEmailHtml } from '../../src/renderer/src/lib/sanitize';

describe('.eml file message in the window', () => {
  it('script, event handlers and remote images are removed or blocked', async () => {
    const svc = new EmlService({ log: nullLogger() }, async () => ({ draftId: 'x' }));
    const html =
      '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="x" onerror="alert(2)"><img src="https://tracker.example.net/p.gif?u=1" width="1" height="1"><a href="javascript:alert(3)">bad</a>';
    const raw = ['From: a@b.com', 'Subject: html', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n');
    await svc.open({ token: 'tok-000001-abcd', data: new Uint8Array(Buffer.from(raw)), fileName: 'a.eml', filePath: 'C:\\a.eml', mtimeMs: 1 });
    const body = svc.get('tok-000001-abcd').body;
    expect(body.html).toContain('<script>');
    const out = sanitizeEmailHtml(body.html!, {});
    for (const h of [out.blocked, out.allowed]) {
      expect(h).toContain('Hi');
      expect(h).not.toMatch(/<script|onclick|onerror|javascript:/i);
    }
    // Remote content is blocked until the user clicks "Load images" in this window.
    expect(out.blocked).not.toMatch(/\ssrc="https:\/\/tracker/);
    expect(out.blocked).toContain('data-blocked-src="https://tracker.example.net');
    // After "Load images" the image comes through the app's local image cache, not straight from the sender.
    expect(out.allowed).toContain('src="letterdock-img://');
  });
});
