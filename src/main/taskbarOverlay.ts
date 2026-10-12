// The unread number on the taskbar button, drawn by Windows itself (DESIGN-SPEC 3.15, addendum 2026-10-12).
// Electron's own `setOverlayIcon` shrinks every overlay to 16 px (TaskbarHost::SetOverlayIcon), and Windows then
// enlarges it again on a 150% screen, which is blurry. So this file talks to ITaskbarList3::SetOverlayIcon directly
// (COM through koffi, a prebuilt FFI library), with an HICON made at the real pixel size.
//
// Two parts:
//  - `loadNativeOverlay()` is the only code that touches koffi and Win32. It throws when anything is missing
//    (koffi not loadable, COM refused), and the caller then falls back to Electron's 16 px overlay.
//  - `HiconOverlay` owns the HICON life cycle on top of that: one icon per window, the old one destroyed after the
//    new one is set, all destroyed at the end. It only needs the small `OverlayNative` interface, so tests mock it.
//
// Nothing here imports Electron.

/** The Win32 and COM calls the overlay needs. HICON and HWND values are BigInt. */
export interface OverlayNative {
  /** Where the code came from, for the log: "koffi 3.3.3". */
  readonly description: string;
  /** An HICON from PNG bytes (PNG inside an icon resource: Vista and later) at `px` x `px`, or null when Windows refuses. */
  createIcon(png: Buffer, px: number): bigint | null;
  destroyIcon(icon: bigint): void;
  /** ITaskbarList3::SetOverlayIcon. Returns the HRESULT (negative = failed). `icon` null clears the overlay. */
  setOverlay(hwnd: bigint, icon: bigint | null, description: string): number;
  /** The id of the "TaskbarButtonCreated" window message (sent again after Explorer restarts), or 0. */
  taskbarCreatedMessage(): number;
  /** Releases the ITaskbarList3 object. */
  release(): void;
}

/** A failed overlay call. `permanent` = it will fail again (stop using the native path); otherwise try again later. */
export class OverlayError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'OverlayError';
  }
}

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16)}`;

/** One overlay per window, with the HICON life cycle. */
export class HiconOverlay {
  private readonly icons = new Map<bigint, bigint>();

  constructor(private readonly native: OverlayNative) {}

  get description(): string {
    return this.native.description;
  }

  taskbarCreatedMessage(): number {
    try {
      return this.native.taskbarCreatedMessage();
    } catch {
      return 0;
    }
  }

  /** Shows the PNG (a `px` x `px` image) as the overlay of `hwnd`. The previous icon of that window is destroyed after. */
  set(hwnd: bigint, png: Buffer, px: number, description: string): void {
    const icon = this.native.createIcon(png, px);
    if (icon === null || icon === 0n) throw new OverlayError('CreateIconFromResourceEx returned no icon', true);
    let hr: number;
    try {
      hr = this.native.setOverlay(hwnd, icon, description);
    } catch (e) {
      this.native.destroyIcon(icon);
      throw e;
    }
    if (hr < 0) {
      this.native.destroyIcon(icon);
      throw new OverlayError(`SetOverlayIcon failed (HRESULT ${hex(hr)})`, false);
    }
    const old = this.icons.get(hwnd);
    this.icons.set(hwnd, icon);
    if (old !== undefined) this.native.destroyIcon(old);
  }

  /** Removes the overlay of `hwnd`. */
  clear(hwnd: bigint): void {
    const hr = this.native.setOverlay(hwnd, null, '');
    if (hr < 0) throw new OverlayError(`SetOverlayIcon(clear) failed (HRESULT ${hex(hr)})`, false);
    this.forget(hwnd);
  }

  /** The window is gone: free its icon (Windows keeps its own copy). */
  forget(hwnd: bigint): void {
    const old = this.icons.get(hwnd);
    if (old === undefined) return;
    this.icons.delete(hwnd);
    this.native.destroyIcon(old);
  }

  dispose(): void {
    for (const icon of this.icons.values()) this.native.destroyIcon(icon);
    this.icons.clear();
    this.native.release();
  }
}

// ---------------------------------------------------------------- koffi + COM
/** The part of koffi that is used (see node_modules/koffi/index.d.ts). */
interface KoffiLike {
  version: string;
  load(lib: string): { func(decl: string): unknown };
  struct(name: string, members: Record<string, unknown>): unknown;
  array(type: string, len: number): unknown;
  proto(decl: string): unknown;
  decode(ptr: unknown, ...rest: unknown[]): unknown;
}
type Fn = (...args: unknown[]) => unknown;

const S_OK = 0;
const S_FALSE = 1;
const RPC_E_CHANGED_MODE = -2147417850; // 0x80010106: this thread already has COM in another model, which is fine
const COINIT_APARTMENTTHREADED = 2;
const CLSCTX_INPROC_SERVER = 1;
const LR_DEFAULTCOLOR = 0;
const ICON_VERSION = 0x00030000;
// ITaskbarList3 virtual table: IUnknown (0-2), HrInit is 3, SetOverlayIcon is 18.
const VT_RELEASE = 2;
const VT_HRINIT = 3;
const VT_SET_OVERLAY_ICON = 18;

const guid = (s: string) => {
  const h = s.replace(/[{}-]/g, '');
  return {
    Data1: parseInt(h.slice(0, 8), 16) >>> 0,
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: [...Buffer.from(h.slice(16), 'hex')],
  };
};
const CLSID_TaskbarList = '56FDF344-FD6D-11d0-958A-006097C9A090';
const IID_ITaskbarList3 = 'EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF';

let loaded: OverlayNative | null = null;

/**
 * Loads koffi and creates the ITaskbarList3 object. Throws when that is not possible (not Windows, koffi missing,
 * COM refused). Call once; the result lives until `release()`. `requireKoffi` is a seam for tests.
 */
export function loadNativeOverlay(
  requireKoffi: () => unknown = () => require('koffi'), // eslint-disable-line @typescript-eslint/no-require-imports
): OverlayNative {
  if (loaded) return loaded;
  if (process.platform !== 'win32') throw new Error('the taskbar overlay is Windows only');
  const koffi = requireKoffi() as KoffiLike;
  const ole32 = koffi.load('ole32.dll');
  const user32 = koffi.load('user32.dll');
  const fn = (lib: { func(decl: string): unknown }, decl: string): Fn => lib.func(decl) as Fn;
  koffi.struct('LD_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
  const coInitializeEx = fn(ole32, 'int32 __stdcall CoInitializeEx(void *reserved, uint32 flags)');
  const coCreateInstance = fn(
    ole32,
    'int32 __stdcall CoCreateInstance(const LD_GUID *clsid, void *outer, uint32 ctx, const LD_GUID *iid, _Out_ void **ppv)',
  );
  const createIconFromResourceEx = fn(
    user32,
    'uint64 __stdcall CreateIconFromResourceEx(const void *bits, uint32 size, int32 isIcon, uint32 version, int32 cx, int32 cy, uint32 flags)',
  );
  const destroyIcon = fn(user32, 'int32 __stdcall DestroyIcon(uint64 icon)');
  const registerWindowMessage = fn(user32, 'uint32 __stdcall RegisterWindowMessageW(str16 name)');

  // Electron's main thread already has COM (apartment model). S_OK / S_FALSE = ready; CHANGED_MODE = someone else set it up.
  const initHr = coInitializeEx(null, COINIT_APARTMENTTHREADED) as number;
  if (initHr !== S_OK && initHr !== S_FALSE && initHr !== RPC_E_CHANGED_MODE) {
    throw new Error(`CoInitializeEx failed (HRESULT ${hex(initHr)})`);
  }
  const out: unknown[] = [null];
  const createHr = coCreateInstance(guid(CLSID_TaskbarList), null, CLSCTX_INPROC_SERVER, guid(IID_ITaskbarList3), out) as number;
  const self = out[0];
  if (createHr < 0 || !self) throw new Error(`CoCreateInstance(TaskbarList) failed (HRESULT ${hex(createHr)})`);

  const vtbl = koffi.decode(self, 'void *');
  const method = (index: number, proto: string): Fn =>
    koffi.decode(koffi.decode(vtbl, index * 8, 'void *'), koffi.proto(proto)) as Fn;
  const hrInit = method(VT_HRINIT, 'int32 __stdcall LD_HrInit(void *self)');
  const setOverlayIcon = method(
    VT_SET_OVERLAY_ICON,
    'int32 __stdcall LD_SetOverlayIcon(void *self, uint64 hwnd, uint64 icon, str16 description)',
  );
  const release = method(VT_RELEASE, 'uint32 __stdcall LD_Release(void *self)');
  const initTaskbarHr = hrInit(self) as number;
  if (initTaskbarHr < 0) {
    release(self);
    throw new Error(`ITaskbarList::HrInit failed (HRESULT ${hex(initTaskbarHr)})`);
  }

  let msg: number | undefined;
  let released = false;
  loaded = {
    description: `koffi ${koffi.version}`,
    createIcon: (png, px) => {
      const h = BigInt(createIconFromResourceEx(png, png.length, 1, ICON_VERSION, px, px, LR_DEFAULTCOLOR) as number | bigint);
      return h === 0n ? null : h;
    },
    destroyIcon: (icon) => void destroyIcon(icon),
    setOverlay: (hwnd, icon, description) => {
      if (released) throw new OverlayError('the taskbar object is released', true);
      return setOverlayIcon(self, hwnd, icon ?? 0n, description) as number;
    },
    taskbarCreatedMessage: () => (msg ??= registerWindowMessage('TaskbarButtonCreated') as number),
    release: () => {
      if (released) return;
      released = true;
      release(self);
    },
  };
  return loaded;
}
