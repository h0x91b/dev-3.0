/**
 * Gives the RUNNING app's window — and therefore its taskbar button — an icon on
 * Windows. This is a different surface from the icon resource embedded into the
 * executables by `embed-windows-icons.ts`, which only governs Explorer, shortcuts
 * and the Start menu.
 *
 * Electrobun registers its `BasicWindowClass` with `hIcon` left at zero and never
 * calls `WM_SETICON`, `LoadIconW` or `SetClassLongPtr` for an app window, so what
 * Windows draws is the system fallback rather than anything anyone loaded. Its own
 * `setWindowIcon` export is an explicit no-op on Windows. See
 * the decision record `runtime-window-icon-via-win32-ffi`.
 *
 * Everything here is platform-agnostic decision logic driven through an injected
 * `Win32IconSurface`, so it is exercised on the machines we actually develop on.
 * The Win32 calls themselves live in `win32-icon-surface.ts`.
 */

/** Big + small icon handles, as returned by `ExtractIconExW`. */
export interface IconPair {
	big: bigint;
	small: bigint;
}

export interface Win32IconSurface {
	/**
	 * Pulls icon index 0 out of a PE file. Returns `null` when the file carries no
	 * icon resource — which is exactly what an executable looks like when the
	 * embedding step in `embed-windows-icons.ts` did not run.
	 */
	extractIcons(exePath: string): IconPair | null;
	/** `true` only if the handle is a live window that accepted both icons. */
	applyToWindow(hwnd: number, icons: IconPair): boolean;
}

/**
 * Where the icon comes from: our own executables, which already carry the icon
 * resource. Reusing them means no extra file to ship, no copy rule to keep in
 * sync, and no guessing at the resource ID rcedit happened to write.
 *
 * `execPath` is the running `bun.exe` and is tried first because it is the one
 * path that cannot be wrong. The bundle-relative entries are the fallback for a
 * layout where the process is started through something else.
 */
export function resolveIconSources(execPath: string, bundleRoot: string, joinPath: (...parts: string[]) => string): string[] {
	const candidates = [execPath, joinPath(bundleRoot, "bin", "bun.exe"), joinPath(bundleRoot, "bin", "launcher.exe")];
	const sources = candidates.filter((path, index) => path.length > 0 && candidates.indexOf(path) === index);
	if (sources.length === 0) {
		throw new Error(
			"No candidate executable to read the window icon from. " +
				"Cause: both process.execPath and the bundle root resolved to empty strings, so the search would have inspected nothing. " +
				"Fix: check the caller in src/bun/window-manager.ts — it must pass process.execPath and process.cwd().",
		);
	}
	return sources;
}

/**
 * Loads the icon from the first source that carries one. Throws rather than
 * returning `null`, because a silent miss here is indistinguishable from success:
 * the window keeps the same default icon either way.
 */
export function loadAppIcon(sources: string[], surface: Win32IconSurface): IconPair {
	if (sources.length === 0) {
		throw new Error(
			"Window icon lookup was handed an empty list of executables. " +
				"Cause: the candidate list was filtered away, so the loop would have run zero times and reported success. " +
				"Fix: pass the full list from resolveIconSources().",
		);
	}

	for (const source of sources) {
		const icons = surface.extractIcons(source);
		if (!icons) continue;
		// A zero handle is Win32's null. Handing it to WM_SETICON REMOVES the icon,
		// so "an IconPair came back" is not the same as "an icon came back" — the two
		// must be separated here or a no-op reports success.
		if (icons.big === 0n || icons.small === 0n) {
			throw new Error(
				`${source} returned a null icon handle (big=${icons.big}, small=${icons.small}). ` +
					"Cause: ExtractIconExW reported an icon but handed back Win32 NULL; passing that to WM_SETICON REMOVES the window's icon instead of setting one. " +
					"Fix: check the icon resource in that executable — src/bun/windows-icons/embed-windows-icons.ts writes it.",
			);
		}
		return icons;
	}

	throw new Error(
		`None of ${sources.join(", ")} carries an icon resource. ` +
			"Cause: the build did not embed the app icon into the Windows executables, so there is nothing to hand the window. " +
			"Fix: check the [windows-icons] lines in the build log and src/bun/windows-icons/embed-windows-icons.ts.",
	);
}

/**
 * Applies the icon to every window handle. An empty list is a failure, not a
 * no-op: this whole module exists because a step that touches nothing currently
 * looks exactly like a step that worked.
 */
export function applyIconToWindows(handles: number[], icons: IconPair, surface: Win32IconSurface): void {
	if (handles.length === 0) {
		throw new Error(
			"Window icon application was handed no window handles. " +
				"Cause: BrowserWindow.ptr was missing or zero, so no window was given an icon while the call reported success. " +
				"Fix: check that electrobun still returns the HWND from createWindow (src/bun/window-manager.ts passes window.ptr).",
		);
	}

	const rejected = handles.filter((handle) => !surface.applyToWindow(handle, icons));
	if (rejected.length > 0) {
		throw new Error(
			`WM_SETICON was rejected for window handle(s) ${rejected.join(", ")}. ` +
				"Cause: the handle is not a live window — electrobun's createWindow no longer returns an HWND, or the window was already destroyed. " +
				"Fix: re-check that createWindowWithFrameAndStyleFromWorker still returns HWND in electrobun's native/win/nativeWrapper.cpp.",
		);
	}
}

export interface WindowIconEnvironment {
	execPath: string;
	bundleRoot: string;
	joinPath(...parts: string[]): string;
}

/** Resolve the icon and put it on one window. */
export function setWindowIcon(handle: number, env: WindowIconEnvironment, surface: Win32IconSurface): void {
	const icons = loadAppIcon(resolveIconSources(env.execPath, env.bundleRoot, env.joinPath), surface);
	applyIconToWindows([handle], icons, surface);
}
