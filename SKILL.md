---
name: skyrim-perk-tree-workflow
description: Parse, validate, render, document, and safely edit Skyrim TES5/SSE perk trees stored in ESP/ESM AVIF records with a cross-platform Mutagen writer. Use for perk-tree shape, coordinates, connections, PERK requirements/effects, SVG previews, Markdown manuals, or new patch ESPs.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
metadata:
  trigger: Skyrim ESP AVIF perk tree SVG Mutagen patch PERK manual
---

# Skyrim Perk Tree Workflow

Use this skill for evidence-backed Skyrim perk-tree analysis and controlled
editing. Read `references/workflow.md` before acting. For edits, also read
`references/mutagen-writer-contract.md`.

## Non-negotiable rules

1. Every source ESP/ESM is read-only. Never overwrite it.
2. Freeze the MO2 profile, map duplicate plugin filenames explicitly, and prove
   the winning `AVIF` override before writing.
3. Use stable FormKeys (`plugin filename|local FormID`), never load-order prefixes.
4. Keep AVIF layout separate from PERK gameplay data.
5. Treat `PNAM = NULL, INAM = 0` as an invisible layout root.
6. Use `logicalX = maxGridX - XNAM - HNAM` and
   `logicalY = YNAM + VNAM` for the displayed geometry.
7. Preserve unresolved and ambiguous records. `origin-record-only` is not
   winning-override proof.
8. Write only a new `.esp` through the bundled Mutagen project. Do not implement
   or invoke a custom Bethesda binary serializer.
9. Require the exact base SHA-256, an approved change-set, Mutagen reopen
   verification, and the independent Node reparse before calling a patch built.
10. xEdit `Check for Errors` and an in-game capture remain later validation
    stages; they are not proof supplied by the writer.

## AVIF fields

- `PNAM`: PERK FormID
- `FNAM`: parent-required flag
- `XNAM`, `YNAM`: grid position
- `HNAM`, `VNAM`: float offsets
- `SNAM`: skill Actor Value
- `CNAM`: outgoing connection target index
- `INAM`: node index

## Read-only analysis

```bash
node scripts/run-readonly-workflow.mjs \
  --input "/absolute/path/to/plugin.esp" \
  --output "/absolute/path/to/output" \
  --master-root "/absolute/path/to/MO2/mods" \
  --plugin-map "/absolute/path/to/plugin-path-map.json" \
  --load-order "/absolute/path/to/plugins.txt" \
  --language "English"
```

Inspect `manifest.json`, `perk-tree-nodes.json`, `perk-tree-details.json`, the
overview SVG, and every tree SVG. Report geometry errors separately from missing
PERKs, strings, referenced records, VMAD, and unmapped CTDA functions.

Generate the complete Markdown manual with:

```bash
node scripts/generate-skill-tree-manual.mjs \
  --details "/absolute/path/to/perk-tree-details.json" \
  --output "/absolute/path/to/skill-tree-manual.md"
```

The generator must document every visible node and fail if its count differs
from the detail export summary.

## Editing with Mutagen

First create and visually approve a version-2 change-set conforming to
`schemas/change-set.schema.json`. Its `basePlugin` and
`expectedWinnerPlugin` must name the exact verified winning file, and
`baseSha256` must match it.

Then run on macOS, Linux, or Windows with Node.js 18+ and .NET SDK 9+:

```bash
node scripts/run-mutagen-write-workflow.mjs \
  --base "/absolute/path/to/verified-winner.esp" \
  --change-set "/absolute/path/to/change-set.json" \
  --output "/absolute/path/to/new-patch.esp" \
  --master-root "/absolute/path/to/MO2/mods" \
  --plugin-map "/absolute/path/to/plugin-path-map.json" \
  --load-order "/absolute/path/to/plugins.txt"
```

The workflow hashes the base before and after, invokes the pinned Mutagen writer,
creates only a new output, reopens and structurally compares it with Mutagen,
then reruns the independent parser and validator. If any stage fails, do not
claim an editable patch exists.

Afterward, confirm the patch wins in the final profile, optionally run SSEEdit
`Check for Errors`, and capture each affected tree in game before calling it
runtime-verified.
