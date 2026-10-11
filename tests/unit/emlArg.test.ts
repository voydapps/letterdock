// .eml files on the command line (DESIGN-SPEC 3.14.2): emlArg.ts
import { describe, expect, it } from 'vitest';
import { findEmlArgs, fileExtension, isDevicePath, isFullWindowsPath } from '../../src/main/emlArg';

describe('findEmlArgs', () => {
  it('finds a full path to an .eml file', () => {
    expect(findEmlArgs(['C:\\Users\\me\\mail.eml'])).toEqual(['C:\\Users\\me\\mail.eml']);
  });

  it('keeps spaces in the path and accepts a pair of quotes around it', () => {
    expect(findEmlArgs(['C:\\My Mail\\saved message.eml'])).toEqual(['C:\\My Mail\\saved message.eml']);
    expect(findEmlArgs(['"C:\\My Mail\\saved message.eml"'])).toEqual(['C:\\My Mail\\saved message.eml']);
  });

  it('matches the extension in any letter case', () => {
    expect(findEmlArgs(['C:\\a\\MAIL.EML', 'C:\\a\\b.Eml'])).toEqual(['C:\\a\\MAIL.EML', 'C:\\a\\b.Eml']);
  });

  it('ignores flags, other files, folders, and the program path', () => {
    expect(
      findEmlArgs([
        '--hidden',
        '--eml=C:\\a\\b.eml',
        'C:\\a\\b.txt',
        'C:\\a\\b.eml.exe',
        'C:\\a\\folder\\',
        'C:\\Program Files\\Letterdock\\Letterdock.exe',
        '',
      ]),
    ).toEqual([]);
  });

  it('ignores a mailto: link and finds the file that comes with it', () => {
    expect(findEmlArgs(['mailto:a@b.com?subject=x.eml', 'C:\\a\\b.eml'])).toEqual(['C:\\a\\b.eml']);
  });

  it('returns several files in order and lists the same file once (any letter case)', () => {
    expect(findEmlArgs(['C:\\a\\1.eml', 'C:\\a\\2.eml', 'c:\\A\\1.EML', 'C:\\a\\3.eml'])).toEqual([
      'C:\\a\\1.eml',
      'C:\\a\\2.eml',
      'C:\\a\\3.eml',
    ]);
  });

  it('accepts a network path (UNC) and a long-path prefix', () => {
    expect(findEmlArgs(['\\\\server\\share\\dir\\m.eml'])).toEqual(['\\\\server\\share\\dir\\m.eml']);
    expect(findEmlArgs(['\\\\?\\C:\\long\\m.eml'])).toEqual(['\\\\?\\C:\\long\\m.eml']);
  });

  it('rejects relative paths, drive-relative paths, device paths and control characters', () => {
    expect(findEmlArgs(['mail.eml', '.\\mail.eml', '..\\mail.eml', '\\mail.eml', 'C:mail.eml'])).toEqual([]);
    expect(findEmlArgs(['\\\\.\\COM1\\m.eml', '\\\\?\\GLOBALROOT\\Device\\x\\m.eml'])).toEqual([]);
    expect(findEmlArgs(['C:\\a\\b\n.eml', 'C:\\a\\\u0000.eml'])).toEqual([]);
  });

  it('survives odd input', () => {
    expect(findEmlArgs([])).toEqual([]);
    expect(findEmlArgs([undefined as unknown as string, 42 as unknown as string])).toEqual([]);
    expect(findEmlArgs(['C:\\' + 'a'.repeat(40000) + '.eml'])).toEqual([]);
  });
});

describe('path helpers', () => {
  it('fileExtension is lower case and uses the last name only', () => {
    expect(fileExtension('C:\\x.y\\file.EML')).toBe('.eml');
    expect(fileExtension('C:\\x.eml\\file')).toBe('');
    expect(fileExtension('C:\\dir\\.eml')).toBe('');
  });

  it('isDevicePath', () => {
    expect(isDevicePath('\\\\.\\PhysicalDrive0')).toBe(true);
    expect(isDevicePath('\\\\?\\GLOBALROOT\\x')).toBe(true);
    expect(isDevicePath('\\\\?\\C:\\a\\b.eml')).toBe(false);
    expect(isDevicePath('\\\\?\\UNC\\server\\share\\b.eml')).toBe(false);
    expect(isDevicePath('C:\\a\\b.eml')).toBe(false);
  });

  it('isFullWindowsPath', () => {
    expect(isFullWindowsPath('C:\\a')).toBe(true);
    expect(isFullWindowsPath('d:/a/b.eml')).toBe(true);
    expect(isFullWindowsPath('\\\\server\\share\\a')).toBe(true);
    expect(isFullWindowsPath('\\\\server')).toBe(false);
    expect(isFullWindowsPath('\\a')).toBe(false);
    expect(isFullWindowsPath('a\\b')).toBe(false);
  });
});
