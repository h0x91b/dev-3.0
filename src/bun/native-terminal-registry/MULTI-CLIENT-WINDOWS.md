# Native writer/observer manual exercise (Windows)

This exercise uses two ordinary PowerShell windows and the isolated registry
driver. It does not start the dev3 app or any tmux process. Use Bun 1.3.14 or
newer and run every command from the repository root.

## 1. Start one native session

In **PowerShell A**:

```powershell
$env:DEV3_NATIVE_SESSIONS_DIR = Join-Path $env:TEMP "dev3-native-ownership-manual"
bun src/bun/native-terminal-registry/cli.ts start ownership-demo --live-parser
bun src/bun/native-terminal-registry/cli.ts attach ownership-demo
```

Expected: A prints `attached as writer`.

In **PowerShell B**:

```powershell
$env:DEV3_NATIVE_SESSIONS_DIR = Join-Path $env:TEMP "dev3-native-ownership-manual"
bun src/bun/native-terminal-registry/cli.ts attach ownership-demo
```

Expected: B replays A's journal, then prints `attached as observer`.

## 2. Prove shared output and observer rejection

In A, type:

```powershell
$env:OWNERSHIP_DEMO = "same-shell"
Write-Output "writer-one"
```

Expected: both windows show `writer-one`. In B, try to type
`Write-Output "must-not-run"`. Expected: B shows a compact `conflict` message,
neither window shows `must-not-run` as command output, and A remains interactive.

Press **Ctrl-]** in B, then run:

```powershell
bun src/bun/native-terminal-registry/cli.ts parser-state ownership-demo
bun src/bun/native-terminal-registry/cli.ts attach ownership-demo
```

Expected: the parser snapshot and replay retain the existing screen/state; B
reattaches as observer while A remains writer.

## 3. Prove writer-only resize

In A, run `$Host.UI.RawUI.WindowSize` and note the columns/rows. Resize only the
B console window, then run `$Host.UI.RawUI.WindowSize` again in A.

Expected: B's viewport change does not change the shared PTY dimensions.

Press **Ctrl-\\** in A to release writer ownership, then **Ctrl-\\** in B to
claim it. Expected: A prints `writer ownership released`; B prints
`writer ownership claimed`. Resize B and run `$Host.UI.RawUI.WindowSize` in B.
Expected: the PTY now follows B, the current writer.

## 4. Prove atomic claim and disconnect takeover

Press **Ctrl-\\** in B to release ownership. Press **Ctrl-\\** in both windows
at nearly the same time.

Expected: exactly one window prints `writer ownership claimed`; the other gets
`conflict`. Type `Write-Output "single-winner"` in the winner and confirm both
windows show it once.

Press **Ctrl-]** in the winner. In the remaining observer, press **Ctrl-\\** and
type:

```powershell
Write-Output "$env:OWNERSHIP_DEMO takeover"
```

Expected: the explicit claim succeeds and prints `same-shell takeover`; the
host and original PowerShell process survived the writer disconnect.

## 5. Stop cleanly

Press **Ctrl-]** in the remaining attached window, then run:

```powershell
bun src/bun/native-terminal-registry/cli.ts stop ownership-demo
```

Expected: `stopped`. No tmux session was created, adopted, or stopped.
