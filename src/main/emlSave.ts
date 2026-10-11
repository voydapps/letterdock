// "Save all" for the attachments of an opened .eml file (DESIGN-SPEC 3.14.3 / 3.14.5): the user picked
// the folder; every name is made safe and an existing file is never overwritten.
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { safeFileName } from '../shared/fileName';

export interface SaveFolderDeps {
  /** Writes the file only when it does not exist yet; rejects with code EEXIST otherwise. */
  writeNew(path: string, data: Uint8Array): Promise<void>;
}

const nodeDeps: SaveFolderDeps = {
  writeNew: (path, data) => writeFile(path, data, { flag: 'wx' }),
};

/** Writes the files into `folder`. Returns how many were saved. A name taken already gets " (2)", " (3)"... */
export async function saveAttachmentsToFolder(
  folder: string,
  files: { filename: string; data: Uint8Array }[],
  deps: SaveFolderDeps = nodeDeps,
): Promise<number> {
  let saved = 0;
  for (const f of files) {
    const name = safeFileName(f.filename);
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 1; n <= 200; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      try {
        await deps.writeNew(join(folder, candidate), f.data);
        saved++;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      }
    }
  }
  return saved;
}
