/**
 * The Win32 half of the runtime window icon: `ExtractIconExW` to read the icon
 * out of one of our own executables, `SendMessageW(WM_SETICON)` to hand it to a
 * live window. Decision logic lives in `window-icon.ts`; this file is only the
 * calls, and is imported dynamically so nothing outside Windows loads it.
 *
 * `user32.dll` and `shell32.dll` are part of Windows itself, so this adds no
 * vendored binary and makes no PATH assumption — the standing rule from the
 * `tmux@3.6` incident (the decision record `pin-tmux-3.6-vendored-keg`).
 */
import type { IconPair, Win32IconSurface } from "./window-icon";

const WM_SETICON = 0x0080;
const ICON_SMALL = 0n;
const ICON_BIG = 1n;

function wide(value: string): Uint16Array {
	const out = new Uint16Array(value.length + 1);
	for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
	return out;
}

/**
 * The extracted handles are kept for the life of the process and shared by every
 * window, so they are deliberately never passed to `DestroyIcon`: one pair of
 * handles per process, released when the process exits.
 */
export async function loadWin32IconSurface(): Promise<Win32IconSurface> {
	const { dlopen, FFIType } = await import("bun:ffi");
	const { i32, ptr, u32, u64 } = FFIType;

	const shell32 = dlopen("shell32.dll", {
		ExtractIconExW: { args: [ptr, i32, ptr, ptr, u32], returns: u32 },
	} as const);
	const user32 = dlopen("user32.dll", {
		SendMessageW: { args: [u64, u32, u64, u64], returns: u64 },
		IsWindow: { args: [u64], returns: i32 },
	} as const);

	const cache = new Map<string, IconPair | null>();

	return {
		extractIcons(exePath: string): IconPair | null {
			const cached = cache.get(exePath);
			if (cached !== undefined) return cached;

			const big = new BigUint64Array(1);
			const small = new BigUint64Array(1);
			const extracted = shell32.symbols.ExtractIconExW(wide(exePath), 0, big, small, 1);
			// A file with no icon resource returns zero icons and leaves both handles
			// null — the same shape as a path that does not exist at all.
			const icons = extracted > 0 && big[0] !== 0n && small[0] !== 0n ? { big: big[0], small: small[0] } : null;
			cache.set(exePath, icons);
			return icons;
		},

		applyToWindow(hwnd: number, icons: IconPair): boolean {
			const handle = BigInt(hwnd);
			// SendMessageW returns the PREVIOUS icon, which is legitimately zero on
			// the first call, so it cannot be the success test. The window handle
			// being live is the only thing worth checking.
			if (user32.symbols.IsWindow(handle) === 0) return false;
			user32.symbols.SendMessageW(handle, WM_SETICON, ICON_BIG, icons.big);
			user32.symbols.SendMessageW(handle, WM_SETICON, ICON_SMALL, icons.small);
			return true;
		},
	};
}
