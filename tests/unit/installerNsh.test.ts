// The Windows installer script (build/installer.nsh) and its self-test must register Letterdock for .eml
// the way DESIGN-SPEC 3.14.1 says, and must never take the default (the user picks it in Default apps).
// This reads the script as text: the real install and uninstall run in the release workflow
// (scripts/test-installer.ps1).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');

/** Lines of one macro, without comments and blank lines. */
function macro(name: string): string[] {
  const m = new RegExp(`!macro ${name}\\r?\\n([\\s\\S]*?)!macroend`).exec(nsh);
  if (!m) throw new Error(`macro ${name} not found`);
  return m[1]!
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';'));
}

const install = macro('customInstall');
const uninstall = macro('customUnInstall');

describe('installer.nsh: .eml registration', () => {
  it('writes the ProgID, its icon, its open command, the capability and the Open with entry', () => {
    expect(install).toContain('WriteRegStr HKCU "Software\\Classes\\Letterdock.eml" "" "Email message"');
    expect(install).toContain(
      'WriteRegStr HKCU "Software\\Classes\\Letterdock.eml\\DefaultIcon" "" "$INSTDIR\\${APP_EXECUTABLE_FILENAME},0"',
    );
    expect(install).toContain(
      'WriteRegStr HKCU "Software\\Classes\\Letterdock.eml\\shell\\open\\command" "" \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"\'',
    );
    expect(install).toContain('WriteRegStr HKCU "Software\\Letterdock\\Capabilities\\FileAssociations" ".eml" "Letterdock.eml"');
    expect(install).toContain('WriteRegStr HKCU "Software\\Classes\\.eml\\OpenWithProgids" "Letterdock.eml" ""');
  });

  it('tells Explorer after install and after uninstall', () => {
    const call = "System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'";
    expect(install).toContain(call);
    expect(uninstall).toContain(call);
  });

  it('never writes the default value of .eml and never touches UserChoice', () => {
    const lines = [...install, ...uninstall];
    const code = lines.join('\n');
    expect(code).not.toMatch(/UserChoice/i);
    expect(code).not.toMatch(/FileExts/i);
    // Any use of the .eml key itself must go through OpenWithProgids.
    for (const line of lines.filter((l) => /Classes\\\.eml/i.test(l))) {
      expect(line, line).toMatch(/Classes\\\.eml\\OpenWithProgids/);
    }
    // Nothing writes to the .eml key itself, and nothing deletes it.
    expect(code).not.toMatch(/WriteReg\w+ HKCU "Software\\Classes\\\.eml" /i);
    expect(code).not.toMatch(/DeleteRegKey\s+HKCU "Software\\Classes\\\.eml"/i);
    expect(code).not.toMatch(/HKLM/i);
  });

  it('uninstall removes the ProgID key, the Open with value and the capability value', () => {
    expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\Letterdock.eml"');
    expect(uninstall).toContain('DeleteRegValue HKCU "Software\\Classes\\.eml\\OpenWithProgids" "Letterdock.eml"');
    expect(uninstall).toContain('DeleteRegValue HKCU "Software\\Letterdock\\Capabilities\\FileAssociations" ".eml"');
    // The Capabilities key (with FileAssociations) goes as before.
    expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Letterdock\\Capabilities"');
  });

  it('keeps the mailto: registration and the "failed old uninstaller is fine" hooks', () => {
    expect(install).toContain('WriteRegStr HKCU "Software\\Letterdock\\Capabilities\\URLAssociations" "mailto" "Letterdock.Url.mailto"');
    expect(install).toContain('WriteRegStr HKCU "Software\\RegisteredApplications" "Letterdock" "Software\\Letterdock\\Capabilities"');
    expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\Letterdock.Url.mailto"');
    expect(uninstall).toContain('DeleteRegValue HKCU "Software\\RegisteredApplications" "Letterdock"');
    expect(nsh).toContain('!macro customUnInstallCheck');
    expect(nsh).toContain('!macro customUnInstallCheckCurrentUser');
    expect(macro('customUnInstallCheck')).toContain('ClearErrors');
  });

  it('electron-builder fileAssociations is not used (it can claim the default)', () => {
    const cfg = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*fileAssociations\s*:/m);
  });
});

describe('scripts/test-installer.ps1', () => {
  const ps = readFileSync(join(root, 'scripts', 'test-installer.ps1'), 'utf8');
  it('checks the .eml keys after install and after uninstall, and that the default was not taken', () => {
    expect(ps).toContain('Letterdock.eml');
    expect(ps).toContain('OpenWithProgids');
    expect(ps).toContain('FileAssociations');
    expect(ps).toContain('UserChoice');
    expect(ps).toMatch(/_\?=/); // the uninstaller runs in place, so the script can wait for it
    expect(ps).toMatch(/after uninstall/);
  });
});

describe('release workflow', () => {
  it('runs the installer self-test before anything is published', () => {
    const wf = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(wf).toContain('./scripts/test-installer.ps1');
  });
});
