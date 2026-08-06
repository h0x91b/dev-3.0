# We set the Windows window/taskbar icon ourselves, from Bun, at runtime

## Context

The decision record `vendor-rcedit-for-windows-icons` gave the Windows executables an icon
resource and closed with the half it could not reach: the **running window and its
taskbar button** stayed on the system default. A PE icon resource governs Explorer,
shortcuts and the Start menu. It does not decorate a window.

The taskbar is where a user looks to know the app is theirs, so an unbranded window
is the most visible way a desktop build reads as unfinished — on the one platform we
are asking people to try for the first time.

## Investigation

Read out of `package/src/native/win/nativeWrapper.cpp` in electrobun, fetched at the
exact tag we ship (`v1.18.1`, `package.json` pins `"electrobun": "1.18.1"`):

- `createWindowWithFrameAndStyleFromWorker` is declared
  **`ELECTROBUN_EXPORT HWND`**. The pointer it returns — surfaced in JS as
  `BrowserWindow.ptr` and passed straight back into every window FFI call — **is the
  raw `HWND`** on Windows. That is the whole enabling fact: the window handle is
  already in our hands, in Bun, with no patching.
- `BasicWindowClass` is registered as `WNDCLASSA wc = {0}` with only `lpfnWndProc`,
  `hInstance` and `lpszClassName` assigned. **`hIcon` is never set**, and the file
  contains no `WM_SETICON`, `LoadIconW` or `SetClassLongPtr` for an app window. The
  only `hIcon` writes are the tray `NOTIFYICONDATA`.
- Electrobun exports `setWindowIcon(void* window, const char* iconPath)` and its
  Windows body is an **explicit no-op** carrying `// TODO: Implement using
  SetWindowIcon/LoadImage APIs`. It works on Linux. So the gap is known upstream and
  unstaffed, not accidental.

**Two corrections to the `vendor-rcedit-for-windows-icons` record**, which read the same file less closely:

| That record says | Actually |
|---|---|
| `WNDCLASSW wc = {0}` with `hCursor` set | `WNDCLASSA wc = {0}`, no `hCursor` (that is `ContainerViewClass`) |
| `hInstance` is the native wrapper **DLL** | `hInstance = GetModuleHandle(NULL)` — the **executable** that loaded the DLL |

Neither changes that record's conclusion (`hIcon` is zero, so the icon is a system
fallback), but the second one matters here: the module the window class belongs to
is `bun.exe`, the very file that record embedded the icon into.

## Decision

**Set the icon at runtime from Bun, through `bun:ffi`, out of our own executable.**

1. `src/bun/windows-icons/win32-icon-surface.ts` — `ExtractIconExW` (shell32) reads
   icon index 0 out of a PE file by **path**, then `SendMessageW(hwnd, WM_SETICON,
   ICON_BIG|ICON_SMALL, hIcon)` (user32) hands it to the window. Both DLLs are part
   of Windows, so this vendors nothing and assumes no binary on `PATH` — the rule
   this repo was burned by in `pin-tmux-3.6-vendored-keg`.
2. The icon source is our own executables: `process.execPath` first, then
   `bin/bun.exe` and `bin/launcher.exe` under the bundle root. That is the icon
   the `vendor-rcedit-for-windows-icons` record already embedded, so this ships **no new asset**, needs **no copy
   rule** in `electrobun.config.ts`, and never guesses at the resource ID rcedit
   happened to write — `ExtractIconExW` addresses it by index, not by name.
3. `src/bun/windows-icons/window-icon.ts` holds all the decision logic behind an
   injected `Win32IconSurface`, so it is unit-tested on macOS. Every assertion in it
   fails on an empty list rather than looping zero times: an empty source list, an
   empty handle list, and a "no executable carried an icon" miss are all errors,
   because a step that decorates nothing is visually identical to one that worked.
4. `src/bun/windows-icons/apply-window-icon.ts` is the call site glue in
   `src/bun/window-manager.ts`, right after `new BrowserWindow`. It is a no-op off
   Windows and **never fatal** — an app that refuses to open a window because it
   could not decorate it is strictly worse than the default icon.
5. Icon handles are extracted once, cached per executable path, shared by every
   window and deliberately never passed to `DestroyIcon`: one pair of handles for
   the life of the process.

## The two failures that look exactly like success

Both are the reason this module has assertions at all, and each is a named guard in
`window-icon.ts` with its own mutation proof:

| The trap | Guard | What it says |
|---|---|---|
| **No executable carries an icon.** A plain local build may never have run the embed step, `ExtractIconExW` returns zero, and nothing is set. | the throw at the end of `loadAppIcon` | names `embed-windows-icons.ts` — so this half's failure cannot be mistaken for the other half's |
| **An icon came back, but the handle is Win32 `NULL`.** `WM_SETICON` with a null handle **REMOVES** the icon rather than setting one, so the app would actively un-decorate its own window while every call reported success. | the null-handle check inside `loadAppIcon`'s loop | names which executable returned it and what `WM_SETICON` would have done |

Six guards, each broken on purpose and confirmed red, then green again: empty
candidate list, empty source list, **null icon handle**, **no executable carries an
icon**, empty window-handle list, handle rejected by `IsWindow`.

## This change is OUT of Windows CI scope, and that is not an oversight

None of the files here appear in `WINDOWS_SCOPE_PATHS`
(`src/shared/windows-ci-scope.ts`); checked by running the repo's own
`windowsScopeHits()` over this commit's file list, which returns `[]`. So the
packaged Windows jobs are **deliberately not dispatched** for this change, and a
green CI run says **nothing** about Windows here.

The list is not extended on purpose: it is held in an open PR by another task, and a
separate task owns auditing it. Widening it from here would collide with both.

## What is verified, and what is not

Agents run on macOS; this defect is visible only on a Windows desktop. **Do not read
this record as "fixed".**

| | What | How far it was checked |
|---|---|---|
| 🟢 | `BrowserWindow.ptr` is the `HWND` | read from electrobun's own source at the pinned tag |
| 🟢 | The decision logic and every assertion | 36 unit tests; all six guards mutation-proved red/green |
| 🟢 | Type-check and the full suite | `bun run lint`, `bun run test` |
| 🔴 | The icon actually appearing in the taskbar | **never observed** — needs a Windows desktop |
| 🔴 | `ExtractIconExW`/`SendMessageW` through `bun:ffi` on Windows | never executed anywhere |

## How to read what a Windows machine shows you

Look at three surfaces — the window's title-bar corner, the taskbar button, and the
Alt-Tab switcher. Explorer is not one of them: it caches an icon per file path and
will show a stale one long after the bytes changed.

| What you see | What it means | What to do |
|---|---|---|
| The app icon | The mechanism works | Nothing |
| No icon — the generic default | Read the single `[window-icon]` line in the log | If it names `embed-windows-icons.ts`, the icon never reached the executable and the fault is in the embed step, not here |
| The icon **disappears** | **The premise of the null-handle guard is wrong.** A null handle cannot reach `WM_SETICON` — that guard throws first — so vanishing means `ExtractIconExW` returned handles that are non-null and still **invalid** | Stop. The fix is a *validity* check on the handles, not a null check. There is no guard for this case |

The third row is the dangerous one and is why the three are written down: a guard
whose premise is false is worse than a missing guard, because it reports success
while proving nothing. **Do not change code before recording which of the three you
saw** — the difference between them is the whole diagnosis, and it is destroyed the
moment the code moves underneath the observation.

## Risks

- **The FFI path has never run.** A wrong `FFIType` or a `dlopen` failure surfaces as
  one warning line and the default icon, not a crash — but it also means the first
  real evidence comes from a Windows machine.
- **`ExtractIconExW` needs the embed from the `vendor-rcedit-for-windows-icons` record to have worked.** If it did
  not, the loop finds no icon and throws a message naming
  `embed-windows-icons.ts`. The two halves are chained on purpose.
- **A future electrobun release may implement `setWindowIcon` on Windows.** Then both
  set the same icon — idempotent and harmless. Delete this module at that point
  rather than keeping two paths (no-deprecation rule).
- **`BrowserWindow.ptr` is an undocumented contract.** If upstream ever returns
  something other than an `HWND`, `IsWindow` rejects it and the assertion names
  `nativeWrapper.cpp` instead of failing silently.

## Alternatives considered

- **Patch or contribute upstream.** Correct in principle and the right long-term home
  — the upstream `TODO` is sitting right there. Rejected as *the* fix because our
  users would wait on someone else's release cycle for an unknown number of months
  for a defect we can close today, and because electrobun's CLI ships as a compiled
  binary we do not build (`vendor-rcedit-for-windows-icons`), so we could not even test a patch locally. Worth
  filing upstream separately; nothing here has to wait on it.
- **Vendor a native shim of our own.** A tiny DLL that does the same three Win32
  calls. Rejected: it adds a binary to build, sign and ship for a job `bun:ffi` does
  with two `dlopen`s against DLLs Windows guarantees, and it would re-create exactly
  the "assume a binary exists" exposure the tmux incident taught us to avoid.
- **Set the icon on the window CLASS** (`SetClassLongPtrW`, `GCLP_HICON`) so windows
  we never see inherit it. Rejected as unnecessary: every dev-3.0 window is created
  through `window-manager.ts`, and a per-window `WM_SETICON` is what the taskbar
  reads. Class-level state shared with electrobun's own internals buys nothing here.
- **Ship an `.ico` next to the app and `LoadImageW` it.** Rejected: a second copy of
  the icon to ship and keep in sync, plus a copy rule in `electrobun.config.ts` —
  which is contended build-config territory — to gain nothing over reading the
  resource already inside our own executable.
- **Accept the default icon and document it.** Rejected. It is the single most
  visible way the Windows build reads as unfinished, and the fix costs three Win32
  calls.
