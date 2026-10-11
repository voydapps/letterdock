// "File mode" of the message window (DESIGN-SPEC 3.14): the message comes from an opened .eml file,
// not from a mailbox. Everything below the provider asks by token (eml.*) instead of by message id.
import { createContext, useContext } from 'react';
import type { EmlMessage } from '../../../../shared/ipc';

export interface FileMode {
  token: string;
  /** The parsed message (header and body), already loaded by the window. */
  message: EmlMessage;
}

export const FileModeContext = createContext<FileMode | null>(null);

/** Non-null inside a message window that shows an .eml file. */
export function useFileMode(): FileMode | null {
  return useContext(FileModeContext);
}
