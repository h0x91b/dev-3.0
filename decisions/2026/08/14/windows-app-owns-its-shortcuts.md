# The Windows app writes and repairs its own shortcuts, and the Setup installer stays unpublished

## Context

A Windows user who downloads `canary-win-x64-dev-3.0-canary.zip` (or the stable zip attached by
`windows-zip-on-the-release-page.md`) gets a launchable tree and no way to reach it again: no
Desktop icon, no Start Menu entry, and an install directory nobody navigates to by hand. Arseny,
on his own box: *"он ставится и запускается вот из этой папки, т.е. после рестарта я фиг найду
как дев 3 запустить... нужна иконка на рабочем столе наврное"*, then *"а может вообще сделать
инсталлер для винды"*.

## Investigation

Read out of electrobun v1.18.1 upstream, not guessed (`gh` code search over
`blackboardsh/electrobun`, then the file itself):

- `createWindowsShortcut` appears in **exactly one** file, `package/src/extractor/main.zig` — the
  self-extracting Setup. Zero occurrences in the launcher and zero in the updater.
- The extractor installs to `%LOCALAPPDATA%\<identifier>\<channel>\app\`, writes two `.lnk`
  (Desktop + `…\Start Menu\Programs`) targeting `…\app\bin\launcher.exe`, and registers an
  Add/Remove Programs entry.
- `Updater.ts` `getAppDataDir()` carries the comment *"Use LOCALAPPDATA to match extractor
  location"* — **the updater installs into the same managed directory and never touches a `.lnk`.**

That last point corrects the premise this task started from. Arseny's screenshot shows
`C:\Users\user\AppData\Local\dev3.electrobun.dev\canary\app\bin`, which is the canonical managed
location, not a stray unzip folder: his app is installed exactly where it belongs and only the
shortcut is missing.

Why the Setup was withheld, twice, on the record:
`downloadable-windows-build-is-the-launched-tree.md` and `windows-zip-on-the-release-page.md` both
say the same thing — nothing has ever launched the Setup exe, and the file a summary hands a human
must be a file the proof launched. Both call it deferred, not rejected. Measured here as well: the
Setup zip is never staged into `artifacts-win-x64/`, so it is not in the bucket at all (an S3 `403`
on that key is indistinguishable from absent without `ListBucket`).

## Decision

**The app writes and repairs its own shortcuts** — `src/bun/windows-shortcuts/`, called once at
startup from `src/bun/index.ts`. `shortcut-plan.ts` is pure decision logic (unit-tested on macOS);
`powershell-surface.ts` does the `WScript.Shell` calls, the same COM object the extractor uses.

Rules, in order: create when no `.lnk` exists and we never wrote one; leave a correct one alone;
**repair** one that points at another directory of ours (an update moved the app); never touch a
shortcut belonging to something else; and never recreate one the user deleted after we wrote it —
`~/.dev3.0/windows-shortcuts.json` records what we wrote, a new file that no other version reads.
The file name mirrors electrobun's `windowsShortcutFileName` byte for byte, including its quirk
that only the literal channel `production` drops the suffix, so a box where Setup also ran does not
end up with two icons.

This is also the **stable pointer** the side-by-side layout work needs: it satisfies a fixed
runtime-discoverable location, a small file rewritten on update rather than a binary, survival of
the old version directory's deletion, and — unlike a Setup-only shortcut — it works for a
zip-unpacked user.

**A directory junction at `app/` was evaluated and rejected**, from the extractor source:
`windowsManagedPathsFromBaseDir` resolves each ancestor with `requirePlainWindowsDirectoryPhysical`
and comments that *"a junction anywhere in LOCALAPPDATA/<identifier>/<channel> is therefore
rejected"*, and `validateWindowsManagedChildIfExists(channel_dir, "app", …)` stats without
following symlinks and accepts only a plain directory or file. A junction at `app` would make the
upstream installer and uninstaller refuse the install location.

## Risks

- **Unverified on Windows.** Every line here was written and tested on macOS; the PowerShell calls
  have never run. Acceptance is Arseny installing, rebooting, and launching from the icon.
- **Startup cost:** up to four short PowerShell invocations on Windows only, off the critical path
  and entirely best-effort — a failure logs a warning and the app starts anyway.
- **A user who moves the app by hand** gets a stale shortcut repaired only if the new location is
  under our identifier or matches what we recorded; otherwise it is left alone rather than clobbered.
- **The Setup is still unpublished and still unproven.** This does not close that gap; it removes
  the urgency behind it.

## Alternatives considered

- **Publish the Setup exe we already build.** It writes both shortcuts, registers an uninstaller,
  and is the shape a real Windows release takes. Rejected for now on the standing rule that no job
  has ever launched it, and because it does nothing for the users who already have the zip —
  including the one who reported this. Deferred behind a second launch-proof target in CI.
- **Build an NSIS/MSI/winget installer.** Most work of the three, and it buys nothing today: there
  is no code-signing certificate (*"сертификата у меня нет и я покупать не хочу"*), so SmartScreen
  warns either way.
- **Ship a `create-shortcut.cmd` inside the zip.** Still requires navigating to the folder, which
  is the problem being solved.
