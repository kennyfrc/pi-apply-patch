# `pi-apply-patch` Golden Master

This directory freezes the behavior of the OpenAI Codex `apply_patch` engine
before the Pi extension is implemented.

## Privacy boundary

No source code, sessions, credentials, or private paths are involved. Both
characterization suites run entirely on synthetic patches written into an
`os.tmpdir()` sandbox that is created and removed per run. There is nothing to
sanitize and nothing to redact; the corpus is safe to commit verbatim.

## Source

Captured from the JDC fork `pi-mono-kenn-dev` at commit
`20b3f0f5cdb542c65bf0b4275828dfae6359d79f` (2026-07-18). `oracle.json` records
every source file and its SHA-256. The engine is a pure-TypeScript
reimplementation of OpenAI's `apply_patch` binary — it takes a patch string and a
`cwd` and returns `{ exitCode, stdout, stderr }`. It has **no external runtime
dependencies** (only `node:fs`, `node:path`, `node:os`), which is what makes a
faithful byte-for-byte port possible.

## Corpus evidence

| Suite | Scenarios | What it verifies |
|---|---|---|
| `apply-patch.golden.txt` | 1 | End-to-end Add File + Update File (hunk) + Move to (rename + update) + Delete File over a sandbox; exact `stdout` summary and `final_state` |
| `apply-patch.matching.golden.txt` | 13 | Every `seekSequence` matching tier — exact, `trimEnd`, `trim`, confusables, invisible chars, whitespace-normalized, unescaped, fuzzy (Levenshtein ≥ 0.8), `@@` context, EOF insertion, pattern-trimmed-for-EOF, add/delete, and the missing-lines compute-error path — each with its full seek trace |

The matching suite is the load-bearing one: the engine applies a patch by
locating each hunk's `oldLines` in the file via a fallthrough of progressively
looser matchers. The trace pins down which tier wins for each scenario, so any
change to matcher order, threshold, or normalization surfaces as a diff here.

## Files

- `oracle.json` — exact source commit, file paths, SHA-256 hashes, and roles.
- `corpus/apply-patch.golden.txt` — frozen end-to-end characterization output.
- `corpus/apply-patch.matching.golden.txt` — frozen matching-tier output.
- `corpus/manifest.json` — machine-readable case index.
- `generate-golden-master.ts` / `generate-matching-golden-master.ts` —
  regenerators that import the package engines and rewrite the corpus. They
  mirror the source `generate-*-golden-master.ts` scripts.

## Required behavior exposed by the capture

- The engine must reproduce both corpus files **byte-for-byte**. This is the
  acceptance test (`test/golden.test.ts`); a single differing byte fails it.
- `apply_patch` summary output is the fixed `Success. Updated the following
  files:` block with `A`/`M`/`D` lines — never an LLM-generated string.
- Update hunks match through the documented tier order (exact → trimEnd → trim
  → unescaped → normalized → whitespace → indentation → fuzzy). Fuzzy requires
  mean similarity ≥ `0.8`; below that the hunk fails with a compute error.
- Path resolution matches `edit`/`write`: `~` expands to home, relative paths
  resolve from `cwd` and **may escape it** (no sandbox jail). This is
  intentional and is asserted by the path-access tests.

## Regeneration order

1. Run `generate-golden-master.ts` and `generate-matching-golden-master.ts`
   against the engine recorded in `oracle.json`.
2. `diff` the regenerated output against `corpus/*.golden.txt`.
3. Only then change the engine, and re-run to confirm the change was intended.

Do not regenerate goldens from the extension under test and then call it
verification — that turns the test into self-confirmation. The corpus is the
pre-change reference; the extension is verified *against* it.
