// Windows mode ("Choose your default Windows mode") for the toast icons (DESIGN-SPEC 3.13.3a).
// Toasts follow SystemUsesLightTheme, not Letterdock's own Theme setting. The value is read once with
// reg.exe (async) and again whenever nativeTheme reports a change, so showing a toast never waits.
import { execFile } from 'node:child_process';

const KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`;

/** Reads `SystemUsesLightTheme` from `reg query` output. true = dark Windows mode; null = unknown. */
export function parseSystemUsesLightTheme(out: string): boolean | null {
  const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  if (!m) return null;
  return parseInt(m[1]!, 16) === 0;
}

/** Dark glyphs? Windows mode wins; when it is unknown, the app's own dark state is the fallback. */
export function toastIsDark(windowsDark: boolean | null, appDark: boolean): boolean {
  return windowsDark ?? appDark;
}

export class WindowsMode {
  private dark: boolean | null = null;
  constructor(
    private readonly query: () => Promise<string> = () =>
      new Promise((resolve, reject) =>
        execFile('reg.exe', ['query', KEY, '/v', 'SystemUsesLightTheme'], { windowsHide: true, timeout: 5000 }, (e, out) =>
          e ? reject(e) : resolve(out),
        ),
      ),
  ) {}
  /** Cached value: true = dark, null = not read yet or the read failed. */
  get isDark(): boolean | null {
    return this.dark;
  }
  async refresh(): Promise<void> {
    try {
      this.dark = parseSystemUsesLightTheme(await this.query());
    } catch {
      this.dark = null;
    }
  }
}
