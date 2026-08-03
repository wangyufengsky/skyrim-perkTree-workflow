$ErrorActionPreference = "Stop"

$Project = Join-Path $PSScriptRoot "..\writer\SkyrimPerkTreeWriter\SkyrimPerkTreeWriter.csproj"
$DotnetExecutable = if ($env:DOTNET_EXECUTABLE) { $env:DOTNET_EXECUTABLE } else { "dotnet" }

& $DotnetExecutable restore $Project --locked-mode
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $DotnetExecutable build $Project --configuration Release --no-restore
exit $LASTEXITCODE
