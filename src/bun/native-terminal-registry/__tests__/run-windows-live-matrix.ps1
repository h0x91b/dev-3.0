# Live-parser Windows matrix runner (seq 1228).
#
# One command on a native Windows host proves the whole STATE-005 slice:
#   1. regression probe — Ghostty inside the Bun.Terminal callback (EXPECTED to
#      fail on Bun 1.3.14: the preserved seq 1185 negative-WASM-pointer repro)
#      vs the deferred pipeline (MUST be clean);
#   2. the live-parser lifecycle E2E (DSR write-back, reconstruction, overflow,
#      fault containment, tmux sentinel);
#   3. the real-TUI matrix through the live host: pwsh 7, Neovim, Claude, Codex
#      — semantic reconstruction match + latency/memory budgets per target.
#
# Privacy: agent targets produce hash+metrics verdicts only (no raw bytes, no
# screen content). Only the <outdir>\share directory should be pasted back;
# <outdir>\raw stays on this machine.
#
# Prerequisites: repo cloned, `bun install` done, Bun 1.3.14 on PATH.
# Log into Claude/Codex beforehand so their TUIs start. Optional targets that
# are not installed are recorded as skipped, not failed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File src\bun\native-terminal-registry\__tests__\run-windows-live-matrix.ps1

param(
	[switch]$SkipAgents,
	[switch]$SkipE2E,
	[int]$Cols = 100,
	[int]$Rows = 30,
	[string[]]$PwshCommand = @("pwsh", "-NoLogo", "-NoProfile"),
	[string[]]$NvimCommand = @("nvim", "--clean", "--cmd", "set noswapfile"),
	[string[]]$ClaudeCommand = @("claude"),
	[string[]]$CodexCommand = @("codex"),
	[string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
if (-not $OutDir) {
	$OutDir = Join-Path ([IO.Path]::GetTempPath()) ("dev3-live-matrix-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$share = Join-Path $OutDir "share"
$raw = Join-Path $OutDir "raw"
$specs = Join-Path $OutDir "specs"
New-Item -ItemType Directory -Force -Path $share, $raw, $specs | Out-Null
Set-Location $repo

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) { throw "bun is required on PATH" }

# ── environment record ──
$os = Get-CimInstance Win32_OperatingSystem
$environment = [ordered]@{
	caption      = $os.Caption
	version      = $os.Version
	build        = $os.BuildNumber
	architecture = $env:PROCESSOR_ARCHITECTURE
	bun          = (& bun --version).Trim()
	powershell51 = $PSVersionTable.PSVersion.ToString()
	capturedAt   = (Get-Date -Format "o")
}
foreach ($probe in @(
	@{ key = "pwsh"; exe = "pwsh"; args = @("-NoProfile", "-Command", '$PSVersionTable.PSVersion.ToString()') },
	@{ key = "nvim"; exe = "nvim"; args = @("--version") },
	@{ key = "claude"; exe = "claude"; args = @("--version") },
	@{ key = "codex"; exe = "codex"; args = @("--version") }
)) {
	$cmd = Get-Command $probe.exe -ErrorAction SilentlyContinue
	if ($cmd) {
		try { $environment[$probe.key] = ((& $cmd.Source @($probe.args) 2>$null) | Select-Object -First 1).ToString().Trim() }
		catch { $environment[$probe.key] = "present (version probe failed)" }
	} else {
		$environment[$probe.key] = "not installed"
	}
}
$environment | ConvertTo-Json | Set-Content (Join-Path $share "environment.json") -Encoding utf8
Write-Host "environment:" ($environment | ConvertTo-Json -Compress)

$results = @()

# ── 1. regression probe: callback (evidence) vs deferred (gate) ──
Write-Host "`n=== regression probe (callback vs deferred) ==="
& bun src\bun\native-terminal-registry\regression-probe.ts both 2>&1 |
	Tee-Object -FilePath (Join-Path $share "regression-probe.txt")
$results += [ordered]@{ step = "regression-probe"; exitCode = $LASTEXITCODE; note = "callback failure on Bun 1.3.14 is the EXPECTED seq 1185 repro; exit gates only the deferred mode" }

# ── 2. live-parser lifecycle E2E ──
if (-not $SkipE2E) {
	Write-Host "`n=== live-parser lifecycle E2E ==="
	& bun run test:native-live-parser-e2e 2>&1 |
		Tee-Object -FilePath (Join-Path $share "live-parser-e2e.txt")
	$results += [ordered]@{ step = "live-parser-e2e"; exitCode = $LASTEXITCODE }
}

# ── 3. real-TUI matrix through the live host ──
function Invoke-Target {
	param(
		[string]$Name,
		[string]$Kind,
		[string[]]$Command,
		[object[]]$Script,
		[string[]]$ExitInputs
	)
	$resolved = Get-Command $Command[0] -ErrorAction SilentlyContinue
	if (-not $resolved) {
		Write-Host "-- ${Name}: not installed, skipped"
		return [ordered]@{ step = "target:$Name"; skipped = $true; reason = "$($Command[0]) not on PATH" }
	}
	$commandLine = @($resolved.Source) + $Command[1..($Command.Length - 1)]
	$spec = [ordered]@{
		target       = $Name
		kind         = $Kind
		command      = $commandLine
		commandLabel = ($Command -join " ")
		cols         = $Cols
		rows         = $Rows
		script       = $Script
		exitInputs   = $ExitInputs
		exitGraceMs  = 8000
	}
	$specPath = Join-Path $specs "$Name.json"
	$spec | ConvertTo-Json -Depth 6 | Set-Content $specPath -Encoding utf8
	$env:DEV3_NATIVE_SESSIONS_DIR = Join-Path $raw "sessions-$Name"
	Write-Host "`n=== target: $Name ($Kind) ==="
	& bun src\bun\native-terminal-registry\__tests__\live-matrix.ts $specPath $share 2>&1 |
		Tee-Object -FilePath (Join-Path $share "$Name.run.txt")
	$code = $LASTEXITCODE
	Remove-Item Env:DEV3_NATIVE_SESSIONS_DIR -ErrorAction SilentlyContinue
	return [ordered]@{ step = "target:$Name"; exitCode = $code }
}

$esc = [string][char]27
$ctrlC = [string][char]3
$backspace = [string][char]8

$results += Invoke-Target -Name "pwsh7" -Kind "shell" -Command $PwshCommand -Script @(
	@{ type = "wait"; ms = 4000 },
	@{ type = "input"; data = "Write-Output `"LIVE-MATRIX-PWSH OK $([char]0x0416) $([char]0x2713)`"`r" },
	@{ type = "wait"; ms = 1500 },
	@{ type = "resize"; cols = 120; rows = 40 },
	@{ type = "wait"; ms = 1200 }
) -ExitInputs @("exit`r")

$results += Invoke-Target -Name "nvim" -Kind "shell" -Command $NvimCommand -Script @(
	@{ type = "wait"; ms = 4500 },
	@{ type = "input"; data = "ihello from the live parser" },
	@{ type = "input"; data = $esc },
	@{ type = "wait"; ms = 1500 },
	@{ type = "resize"; cols = 120; rows = 40 },
	@{ type = "wait"; ms = 1500 }
) -ExitInputs @(":q!`r")

if (-not $SkipAgents) {
	$results += Invoke-Target -Name "claude" -Kind "agent" -Command $ClaudeCommand -Script @(
		@{ type = "wait"; ms = 15000 },
		@{ type = "input"; data = "h" },
		@{ type = "wait"; ms = 2000 },
		@{ type = "resize"; cols = 120; rows = 40 },
		@{ type = "wait"; ms = 3000 }
	) -ExitInputs @($backspace, "/exit`r")

	$results += Invoke-Target -Name "codex" -Kind "agent" -Command $CodexCommand -Script @(
		@{ type = "wait"; ms = 15000 },
		@{ type = "input"; data = "h" },
		@{ type = "wait"; ms = 2000 },
		@{ type = "resize"; cols = 120; rows = 40 },
		@{ type = "wait"; ms = 3000 }
	) -ExitInputs @($backspace, $ctrlC, $ctrlC)
}

$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $share "results.json") -Encoding utf8

# ── summary ──
Write-Host "`n===================== SUMMARY ====================="
foreach ($entry in $results) {
	if ($entry.Contains("skipped") -and $entry.skipped) {
		Write-Host ("{0,-24} SKIPPED ({1})" -f $entry.step, $entry.reason)
	} else {
		$verdictLabel = if ($entry.exitCode -eq 0) { "OK" } else { "EXIT $($entry.exitCode)" }
		Write-Host ("{0,-24} {1}" -f $entry.step, $verdictLabel)
	}
}
Write-Host "`nShare (paste its contents back): $share"
Write-Host "Raw (keep local, do NOT share):  $raw"
