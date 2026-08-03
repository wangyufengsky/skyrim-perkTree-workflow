#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_ROOT=$(dirname -- "$SCRIPT_DIR")
DESTINATION=${1:-"${CODEX_HOME:-$HOME/.codex}/skills/skyrim-perk-tree-workflow"}

if [ -e "$DESTINATION" ]; then
  echo "Refusing to overwrite existing destination: $DESTINATION" >&2
  exit 1
fi

DESTINATION_PARENT=$(dirname -- "$DESTINATION")
mkdir -p "$DESTINATION_PARENT"
cp -R "$SKILL_ROOT" "$DESTINATION"

echo "Installed Skyrim Perk Tree Workflow to:"
echo "$DESTINATION"
echo "Restart Codex, then invoke: \$skyrim-perk-tree-workflow"
