param(
    [string]$Destination
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Destination)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        $CodexRoot = $env:CODEX_HOME
    }
    else {
        $CodexRoot = Join-Path $env:USERPROFILE ".codex"
    }
    $Destination = Join-Path $CodexRoot "skills\skyrim-perk-tree-workflow"
}

if (Test-Path -LiteralPath $Destination) {
    throw "Refusing to overwrite existing destination: $Destination"
}

$DestinationParent = Split-Path -Parent $Destination
New-Item -ItemType Directory -Path $DestinationParent -Force | Out-Null
Copy-Item -LiteralPath $SkillRoot -Destination $Destination -Recurse

Write-Host "Installed Skyrim Perk Tree Workflow to:"
Write-Host $Destination
Write-Host 'Restart Codex, then invoke: $skyrim-perk-tree-workflow'
