param(
    [string]$Bun = "bun",
    [int]$Sessions = 4,
    [int]$Reconnects = 24,
    [int]$CreateStop = 6,
    [string]$Out = "$env:TEMP\dev3-native-soak-summary.json"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
    throw "The native-session soak gate must run on native Windows."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
Push-Location $repoRoot
try {
    $version = (& $Bun --version).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not run Bun from '$Bun'."
    }
    if ($version -ne "1.3.14") {
        throw "Expected Bun 1.3.14, found $version."
    }

    & $Bun "src/bun/native-terminal-soak/run-soak.ts" `
        "--sessions" $Sessions "--reconnects" $Reconnects "--create-stop" $CreateStop "--out" $Out
    if ($LASTEXITCODE -ne 0) {
        throw "Native terminal soak FAILED. Machine-readable reasons: $Out"
    }
    Write-Host "Native terminal soak PASSED. Summary: $Out"
} finally {
    Pop-Location
}
