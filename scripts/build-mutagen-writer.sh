#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$script_dir/../writer/SkyrimPerkTreeWriter/SkyrimPerkTreeWriter.csproj"
dotnet_executable="${DOTNET_EXECUTABLE:-dotnet}"

"$dotnet_executable" restore "$project" --locked-mode
"$dotnet_executable" build "$project" --configuration Release --no-restore
