# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/FSerlyta/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/FSerlyta/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one specification (`SPEC.md`):

- **unified diffs** — often with wrong line numbers; hunks are located by content,
  nearest to the header's line number, and applied in order;
- **SEARCH/REPLACE blocks** — with the path on the line above, fences and prose
  ignored, and a second block inheriting the previous block's path;
- **V4A patches** — `*** Begin Patch` / `*** End Patch` with Add / Delete / Update
  File sections, `@@` anchors, a cursor, and `*** End of File` chunks;
- **JSON tool calls** — one array of edit objects, or one edit object per line
  (`create`, `str_replace`, `insert`).

Matching is at three tiers (exact; trailing whitespace ignored; leading and
trailing whitespace ignored, with new lines re-indented), or exact only with
`--strict`. Every file is changed or none: a failed edit changes nothing, later
edits still run, and all failures are reported. See `SPEC.md` for the whole
contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-` / absent for standard input. `--format` is
`auto` (the default), `unified`, `search-replace`, `v4a` or `json`. `--check`
does everything but write. Exit codes: 0 applied, 1 some edits failed, 2
usage / missing patch / unknown format / parse error.

Node 22 and its standard library alone; nothing is installed.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner, kept as shipped: in a trial it reads the
  checks from the environment and runs `main.ts` on each one.
- `check.ts` — run the public practice set on your own machine:
  `node check.ts <practice.json>` (the kit carries it at
  `program/generator/practice.json`).
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## Verification

`node check.ts <practice.json>`: **100 of 100 practice checks pass
(practice score 1000)**, run twice with identical results. A further 66
hand-written edge checks for sentences the practice set does not show
(rename-only sections, `new file mode`, malformed hunks, `\ No newline`,
insertions past end of file, CRLF without a final break, SEARCH/REPLACE path
inheritance, V4A move-only updates and end-of-file chunks, JSON overlapping
matches, CLI usage errors, move output rows and sorting) pass 66 of 66.
See `build-log.md` for the numbers, the comparison with the house strict
applier, and the known judgment calls.
