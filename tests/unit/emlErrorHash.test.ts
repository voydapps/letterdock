import { describe, expect, it } from 'vitest';
import { EML_ERROR_WINDOW_MAX, readEmlErrorHash, type EmlErrorItem } from '../../src/shared/emlErrors';
import { emlErrorHash } from '../../src/main/viewerState';

describe('hash of the error window (app started with files that did not open)', () => {
  it('carries every file with its reason, in order, also odd characters', () => {
    const items: EmlErrorItem[] = [
      { code: 'notEmail', fileName: 'a & b=c.eml' },
      { code: 'tooLarge', fileName: 'große Datei #1.eml' },
    ];
    expect(readEmlErrorHash('#' + emlErrorHash(items))).toEqual(items);
  });

  it('lists at most 5 files', () => {
    const items: EmlErrorItem[] = Array.from({ length: 8 }, (_, i) => ({ code: 'unreadable', fileName: `f${i}.eml` }));
    const back = readEmlErrorHash(emlErrorHash(items));
    expect(back).toHaveLength(EML_ERROR_WINDOW_MAX);
    expect(back.map((x) => x.fileName)).toEqual(['f0.eml', 'f1.eml', 'f2.eml', 'f3.eml', 'f4.eml']);
  });

  it('reads the old one-code form, and turns an unknown code into "unreadable"', () => {
    expect(readEmlErrorHash('#emlerror=notEmail')).toEqual([{ code: 'notEmail', fileName: '' }]);
    expect(readEmlErrorHash('#emlerror=bogus')).toEqual([{ code: 'unreadable', fileName: '' }]);
    expect(readEmlErrorHash('#msg=3')).toEqual([]);
  });
});
