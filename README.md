# pi-apply-patch

OpenAI Codex `apply_patch` file-editing tool for Pi, active only for GPT-family
models, where it replaces the built-in `edit` and `write` tools.

## What it does

- Registers the `apply_patch` tool — the structured-patch format GPT models emit
  natively (`*** Begin Patch` / Add/Delete/Update + `@@` hunks / `*** End Patch`).
- For a **GPT model**, swaps the active tool set: `apply_patch` on, `edit` +
  `write` off. A `tool_call` blocker is the backstop if the swap lags.
- For a **non-GPT model** (e.g. a GLM model over an OpenAI-compatible router),
  hides `apply_patch` and restores `edit` + `write`. Nothing else is touched.

The engine is a byte-identical port of the JDC fork's dependency-free
TypeScript reimplementation of OpenAI's `apply_patch` binary (source commit
`20b3f0f`). No external binary is required.

## GPT model detection (locked default)

A model is treated as GPT when **any** of:

- `model.id` starts with `gpt` (gpt-5, gpt-4o, gpt-4.1, gpt-5-codex)
- `model.id` matches `^o\d` (o1, o3, o4, o1-pro, o4-mini)
- `model.api === "openai-codex-responses"`

This is router-robust and excludes Claude, Gemini, and GLM. Override with the
config/env below; no code change required.

## Configuration

The config file is the only override; there is no env var. Precedence: config
file > defaults.

- **Config `~/.pi/agent/pi-apply-patch.json`** —
  `{"mode": "auto" | "on" | "off", "gptIdPatterns": ["^gpt", "^o\\d"]}`.
  `mode` `on` forces apply_patch for every model; `off` disables it everywhere
  (restores edit + write); `auto` (default) uses the predicate. Custom patterns
  replace the defaults.

The config cache resets on `session_start` and `/reload`, so edits apply without
restarting.

## Files

| Path | Origin | Role |
|------|--------|------|
| `src/engine.ts` | verbatim port | Pure-TS apply_patch engine |
| `src/parse.ts` | verbatim port | Op extractor for undo |
| `src/runner.ts` | verbatim port | Thin engine wrapper |
| `src/characterization.ts` / `matching-characterization.ts` | verbatim port | Golden-master generators |
| `src/prompt.ts` | verbatim text | Tool description (model contract) |
| `src/tool.ts` | adapted | Pi `ToolDefinition` wrapper + undo snapshots |
| `src/gate.ts` | new | Model predicate + tool-swap + config |
| `src/index.ts` | new | Extension factory |

## Golden master & design doc

- **Golden master:** [`golden-masters/apply-patch/`](../../golden-masters/apply-patch) —
  `oracle.json` records the source commit and SHA-256 of every ported file; the
  corpus freezes 14 scenarios (1 end-to-end + 13 matching tiers) that the engine
  must reproduce byte-for-byte.
- **Design doc + call graph:**
  [`devdocs/designs/apply-patch-extension.html`](../../devdocs/designs/apply-patch-extension.html)

## Develop

```bash
npm run check:apply-patch   # tsc --noEmit
npm run test:apply-patch    # vitest: 26 tests incl. golden comparison
```

Regenerate the golden corpus from the package engines (then diff — must be
empty):

```bash
npx tsx golden-masters/apply-patch/generate-golden-master.ts
npx tsx golden-masters/apply-patch/generate-matching-golden-master.ts
```
