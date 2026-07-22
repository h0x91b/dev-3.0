param(
    [string]$Bun = "bun"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
    throw "This verification must run on native Windows."
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

    & $Bun "src/bun/native-terminal-registry/__tests__/crash-recovery.bun-e2e.ts"
    if ($LASTEXITCODE -ne 0) {
        throw "Native-session host crash recovery proof failed."
    }
} finally {
    Pop-Location
}
