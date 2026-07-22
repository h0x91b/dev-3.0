# Native Windows shell launch proof for the isolated registry.
# Requires Windows PowerShell 5.1, PowerShell 7, cmd.exe, and Bun 1.3.14.
# Git Bash and WSL are detected and reported as optional/skipped.

param(
	[string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$matrix = Join-Path $PSScriptRoot "windows-shell-matrix.ts"
if (-not $OutDir) {
	$OutDir = Join-Path ([IO.Path]::GetTempPath()) ("dev3-windows-shell-matrix-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

function Get-ApplicationPath {
	param([Parameter(Mandatory = $true)][string]$Name)
	$path = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
		Where-Object { $_.Source -and (Test-Path -LiteralPath $_.Source -PathType Leaf) } |
		Select-Object -First 1 -ExpandProperty Source
	if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
		return [string]((Resolve-Path -LiteralPath $path).Path)
	}
	return ""
}

$bunPath = Get-ApplicationPath -Name "bun"
if (-not $bunPath) { throw "bun is required on PATH" }
$bunVersion = ((& $bunPath --version) | Select-Object -First 1).ToString().Trim()
if ($bunVersion -ne "1.3.14") { throw "Bun 1.3.14 is required; detected $bunVersion" }

function Get-ApplicationDetection {
	param(
		[string]$Path,
		[string]$Version
	)
	if ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
		return [ordered]@{ detected = $true; path = (Resolve-Path -LiteralPath $Path).Path; version = $Version }
	}
	return [ordered]@{ detected = $false; reason = "requested executable not found" }
}

$ps51Path = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$ps51Version = if (Test-Path $ps51Path) {
	((& $ps51Path -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()') | Select-Object -First 1).ToString().Trim()
} else { "" }

$pwshPath = Get-ApplicationPath -Name "pwsh.exe"
$pwshVersion = if ($pwshPath) {
	((& $pwshPath -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()') | Select-Object -First 1).ToString().Trim()
} else { "" }

$cmdPath = $env:ComSpec
$cmdVersion = if ($cmdPath -and (Test-Path $cmdPath)) {
	((& $cmdPath /D /C ver) | Where-Object { $_.Trim() } | Select-Object -First 1).ToString().Trim()
} else { "" }

$gitBashCandidates = @(
	(Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
	(Join-Path $env:ProgramFiles "Git\usr\bin\bash.exe")
)
if (${env:ProgramFiles(x86)}) {
	$gitBashCandidates += Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe"
}
$gitPath = Get-ApplicationPath -Name "git.exe"
if ($gitPath) {
	$gitRoot = Split-Path (Split-Path $gitPath -Parent) -Parent
	$gitBashCandidates += Join-Path $gitRoot "bin\bash.exe"
}
$gitBashPath = $gitBashCandidates | Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } | Select-Object -First 1
$gitBash = if ($gitBashPath) {
	$version = ((& $gitBashPath --version 2>$null) | Select-Object -First 1).ToString().Trim()
	[ordered]@{ detected = $true; path = (Resolve-Path $gitBashPath).Path; version = $version; reason = "optional target detected but intentionally skipped" }
} else {
	[ordered]@{ detected = $false; reason = "Git Bash not installed; optional target skipped" }
}

$wslPath = Get-ApplicationPath -Name "wsl.exe"
$wsl = if ($wslPath) {
	$distros = @(& $wslPath -l -q 2>$null |
		ForEach-Object { ([string]$_).Replace(([char]0).ToString(), [string]::Empty).Trim() } |
		Where-Object { $_ })
	$label = if ($distros.Count -gt 0) { ($distros -join ", ") } else { "no registered distributions" }
	[ordered]@{ detected = $true; path = $wslPath; version = $label; reason = "optional target detected but intentionally skipped" }
} else {
	[ordered]@{ detected = $false; reason = "wsl.exe not installed; optional target skipped" }
}

$config = [ordered]@{
	outputDir = $OutDir
	capturedAt = (Get-Date -Format "o")
	required = [ordered]@{
		"windows-powershell-5.1" = (Get-ApplicationDetection -Path $ps51Path -Version $ps51Version)
		"powershell-7" = (Get-ApplicationDetection -Path $pwshPath -Version $pwshVersion)
		"cmd" = (Get-ApplicationDetection -Path $cmdPath -Version $cmdVersion)
	}
	optional = [ordered]@{
		"git-bash" = $gitBash
		"wsl" = $wsl
	}
}
$configPath = Join-Path $OutDir "matrix-config.json"
$config | ConvertTo-Json -Depth 6 | Set-Content $configPath -Encoding utf8

Set-Location $repo
Write-Host "Bun:" $bunVersion
Write-Host "Output:" $OutDir
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $bunPath $matrix $configPath 2>&1 | Tee-Object -FilePath (Join-Path $OutDir "windows-shell-matrix.txt")
$matrixExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction

Write-Host "`nShareable verdict:" (Join-Path $OutDir "share\windows-shell-verdict.json")
Write-Host "Raw diagnostics:" (Join-Path $OutDir "raw")
if ($matrixExit -ne 0) { exit $matrixExit }
