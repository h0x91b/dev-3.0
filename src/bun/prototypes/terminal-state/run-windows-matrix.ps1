<#
.SYNOPSIS
    Runs the Windows shell/agent terminal-state capture matrix for the spike.

.DESCRIPTION
    Captures cmd.exe, PowerShell 7 (pwsh), Claude, and Codex through the raw PTY
    path (Ghostty stays out of the Bun 1.3.14 Windows callback), replays each
    capture offline for a semantic roundtrip verdict, and sanitizes the results.

    Only shareable artifacts are written to <outdir>\share:
      - <target>.metrics.json           (hash + structural metrics, always)
      - <target>.sanitized-journal.json (deterministic shell captures only, when clean)
      - <target>.verdict.json           (replay match + capability coverage)
      - environment.json, results.json, suite.txt, benchmark.txt
    Raw journals stay in <outdir>\raw and MUST NOT be shared.

    Runs under Windows PowerShell 5.1 or PowerShell 7. Log into Claude and Codex
    before running so their interactive TUIs start.

.NOTES
    Nothing here is imported by production; it only exercises the prototype.
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $env:TEMP ("dev3-win-matrix-" + (Get-Date -Format "yyyyMMdd-HHmmss"))),
    [int]$Cols = 100,
    [int]$Rows = 30,
    [string[]]$ClaudeCommand = @("claude"),
    [string[]]$CodexCommand = @("codex"),
    [switch]$SkipAgents,
    [switch]$SkipSuite
)

$ErrorActionPreference = "Stop"
$ts = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $ts "..\..\..\..")).Path
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$raw = Join-Path $OutDir "raw"
$share = Join-Path $OutDir "share"
New-Item -ItemType Directory -Force -Path $raw, $share | Out-Null

# Windows PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM that breaks
# bun's JSON.parse of the spec files; always write BOM-less UTF-8.
function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ToolVersion {
    param([string]$Command, [string[]]$VersionArgs = @("--version"))
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return "not found" }
    try { return ((& $Command @VersionArgs 2>&1) | Out-String).Trim() } catch { return "error: $_" }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun is required on PATH to run the capture matrix."
}

$osInfo = Get-CimInstance Win32_OperatingSystem
$platformLabel = "Windows $($osInfo.Version) $($env:PROCESSOR_ARCHITECTURE); Bun $(bun --version)"
$capturedAt = (Get-Date -Format "yyyy-MM-dd")

$environment = [ordered]@{
    windowsCaption = $osInfo.Caption
    windowsVersion = $osInfo.Version
    windowsBuild   = $osInfo.BuildNumber
    architecture   = $env:PROCESSOR_ARCHITECTURE
    bun            = Get-ToolVersion -Command "bun"
    node           = Get-ToolVersion -Command "node"
    cmd            = ((cmd /c ver) | Out-String).Trim()
    powershell51   = Get-ToolVersion -Command "powershell" -VersionArgs @("-NoProfile", "-Command", '$PSVersionTable.PSVersion.ToString()')
    pwsh7          = Get-ToolVersion -Command "pwsh" -VersionArgs @("--version")
    claude         = Get-ToolVersion -Command $ClaudeCommand[0]
    codex          = Get-ToolVersion -Command $CodexCommand[0]
    capturedAt     = $capturedAt
}
Write-Utf8NoBom -Path (Join-Path $share "environment.json") -Content ($environment | ConvertTo-Json -Depth 6)
Write-Host "=== Environment ===" -ForegroundColor Cyan
$environment.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-14} {1}" -f $_.Key, $_.Value) }

$results = [System.Collections.Generic.List[object]]::new()

function Invoke-Target {
    param(
        [string]$Target,
        [string]$Kind,
        [string[]]$Command,
        [string]$CommandLabel,
        [bool]$RespondToQueries,
        [object[]]$Script
    )
    Write-Host "`n=== Capturing $Target ===" -ForegroundColor Cyan
    $spec = [ordered]@{
        target           = $Target
        kind             = $Kind
        command          = $Command
        commandLabel     = $CommandLabel
        cwd              = $repoRoot
        cols             = $Cols
        rows             = $Rows
        respondToQueries = $RespondToQueries
        script           = $Script
        exitGraceMs      = 3000
        platform         = $platformLabel
        capturedAt       = $capturedAt
    }
    $specPath = Join-Path $raw "$Target.spec.json"
    $journalPath = Join-Path $raw "$Target.journal.json"
    Write-Utf8NoBom -Path $specPath -Content ($spec | ConvertTo-Json -Depth 12)

    $entry = [ordered]@{ target = $Target; kind = $Kind; captured = $false; gap = $null }
    try {
        & bun (Join-Path $ts "capture-session.ts") $specPath $journalPath
        $entry.captured = $true
    } catch {
        $entry.gap = "capture failed: $_"
        $results.Add([pscustomobject]$entry); return
    }

    try {
        $verdictJson = (& bun (Join-Path $ts "verify-journal.ts") $journalPath 2>&1 | Out-String)
        Write-Utf8NoBom -Path (Join-Path $share "$Target.verdict.json") -Content $verdictJson
        $verdict = $verdictJson | ConvertFrom-Json
        $entry.matchesAtDetach = $verdict.matchesAtDetach
        $entry.matchesAfterReplay = $verdict.matchesAfterReplay
        $entry.coverage = $verdict.coverage
    } catch {
        $entry.gap = "verify failed: $_"
    }

    try {
        & bun (Join-Path $ts "sanitize-cli.ts") $journalPath $share
    } catch {
        $entry.gap = (@($entry.gap, "sanitize failed: $_") | Where-Object { $_ }) -join "; "
    }

    $journal = Get-Content $journalPath -Raw | ConvertFrom-Json
    $entry.exitCode = $journal.provenance.exitCode
    $entry.responderReplies = $journal.responderReplies
    $results.Add([pscustomobject]$entry)
}

# --- Shells: deterministic, no query responder needed ---
$shellScript = @(
    @{ type = "wait"; ms = 2000 },
    @{ type = "detach" },
    @{ type = "wait"; ms = 300 }
)
Invoke-Target -Target "cmd" -Kind "shell" -RespondToQueries $false -Script $shellScript `
    -Command @("cmd", "/d", "/c", (Join-Path $ts "cmd-probe.bat")) -CommandLabel "cmd /d /c cmd-probe.bat"

if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    Invoke-Target -Target "pwsh7" -Kind "shell" -RespondToQueries $false -Script $shellScript `
        -Command @("pwsh", "-NoLogo", "-NoProfile", "-File", (Join-Path $ts "pwsh-probe.ps1")) `
        -CommandLabel "pwsh -NoLogo -NoProfile -File pwsh-probe.ps1"
} else {
    Write-Host "pwsh 7 not found; recording as unavailable." -ForegroundColor Yellow
    $results.Add([pscustomobject]@{ target = "pwsh7"; kind = "shell"; captured = $false; gap = "pwsh 7 not installed on this host" })
}

# --- Agents: interactive TUI, responder answers startup queries ---
# Content-free scripted interaction: startup, a benign keystroke, a resize, a
# detach boundary, then a quit. Adjust the quit keys per agent if needed.
$ESC = [string][char]27
$CtrlC = [string][char]3
$agentScript = @(
    @{ type = "wait"; ms = 4000 },
    @{ type = "input"; data = "ping" },
    @{ type = "wait"; ms = 800 },
    @{ type = "resize"; cols = ($Cols + 20); rows = ($Rows + 10) },
    @{ type = "wait"; ms = 1200 },
    @{ type = "detach" },
    @{ type = "input"; data = $ESC },
    @{ type = "input"; data = $CtrlC },
    @{ type = "wait"; ms = 900 },
    @{ type = "input"; data = $CtrlC },
    @{ type = "wait"; ms = 1500 }
)

if (-not $SkipAgents) {
    foreach ($agent in @(
            @{ Target = "claude"; Command = $ClaudeCommand },
            @{ Target = "codex"; Command = $CodexCommand })) {
        if (Get-Command $agent.Command[0] -ErrorAction SilentlyContinue) {
            Invoke-Target -Target $agent.Target -Kind "agent" -RespondToQueries $true -Script $agentScript `
                -Command $agent.Command -CommandLabel ($agent.Command -join " ")
        } else {
            Write-Host "$($agent.Target) not found; recording as gap." -ForegroundColor Yellow
            $results.Add([pscustomobject]@{ target = $agent.Target; kind = "agent"; captured = $false; gap = "$($agent.Target) not on PATH" })
        }
    }
}

# --- Spike suite + benchmark ---
$suiteExit = $null
if (-not $SkipSuite) {
    Write-Host "`n=== Spike suite ===" -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        Write-Utf8NoBom -Path (Join-Path $share "suite.txt") -Content (& bun run test:terminal-state-spike 2>&1 | Out-String)
        $suiteExit = $LASTEXITCODE
        Write-Utf8NoBom -Path (Join-Path $share "benchmark.txt") -Content (& bun run benchmark:terminal-state-spike 2>&1 | Out-String)
    } finally { Pop-Location }
}

$summary = [ordered]@{
    environment = $environment
    targets     = $results
    suiteExit   = $suiteExit
    generatedAt = (Get-Date -Format "s")
}
Write-Utf8NoBom -Path (Join-Path $share "results.json") -Content ($summary | ConvertTo-Json -Depth 12)

Write-Host "`n=== Matrix summary ===" -ForegroundColor Green
$results | Format-Table target, kind, captured, matchesAtDetach, matchesAfterReplay, exitCode, gap -AutoSize
Write-Host "Suite exit: $suiteExit"
Write-Host "`nShare these files back (safe, sanitized):" -ForegroundColor Green
Write-Host "  $share"
Write-Host "Raw journals stay local (DO NOT share):" -ForegroundColor Yellow
Write-Host "  $raw"
