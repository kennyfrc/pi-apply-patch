/**
 * Model-gating for the apply_patch extension.
 *
 * Ported concept: in the reference implementation's tool selection, the
 * "apply_patch replaces edit/write" mode is exactly
 * `resolvedNames.includes("apply_patch") &&
 * !resolvedNames.includes("edit")`. This extension reproduces that swap on Pi
 * using pi.setActiveTools, gated to GPT-family models so non-GPT models (e.g. a
 * GLM model served over an OpenAI-compatible router) keep edit/write.
 *
 * Locked default (spec, AFK-safe): a model is "GPT" when its id starts with
 * `gpt` (gpt-5/gpt-4o/gpt-4.1), matches the o-series id shape `o\d…`
 * (o1/o3/o4/o1-pro/o4-mini), OR its api is `openai-codex-responses`. This is
 * router-robust (ids survive OpenAI-compatible gateways) and excludes
 * Claude/Gemini/GLM. Override via the config file without touching code.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal model shape the gate needs. Structurally compatible with pi's Model. */
export interface GatableModel {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
}

/** Tools this extension owns the visibility of. Everything else is left alone. */
export const MANAGED_TOOLS = ["edit", "write", "apply_patch"] as const;
const managedSet: ReadonlySet<string> = new Set(MANAGED_TOOLS);

/** Default id patterns that mark a model as GPT-family. */
export const DEFAULT_GPT_ID_PATTERNS: readonly RegExp[] = [
  /^gpt/i, // gpt-5, gpt-4o, gpt-4.1
  /^o\d/i, // o1, o3, o4, o1-pro, o4-mini
];

export type FeatureMode = "auto" | "on" | "off";

export interface ApplyPatchConfig {
  mode: FeatureMode;
  gptIdPatterns: readonly RegExp[];
}

let cachedConfig: ApplyPatchConfig | undefined;

function compilePatterns(raw: unknown): readonly RegExp[] {
  if (!Array.isArray(raw)) return DEFAULT_GPT_ID_PATTERNS;
  const compiled: RegExp[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    try {
      compiled.push(new RegExp(entry));
    } catch {
      // Ignore malformed patterns rather than failing the whole gate.
    }
  }
  return compiled.length > 0 ? compiled : DEFAULT_GPT_ID_PATTERNS;
}

/**
 * Load config from `~/.pi/agent/pi-apply-patch.json`. The result is cached
 * for the session and reset on `session_start` / `/reload` via
 * `resetConfigCache()`, so edits apply without restarting — same philosophy
 * as pi-static-compactor.
 *
 * Config shape: `{ "mode": "auto" | "on" | "off", "gptIdPatterns": ["^gpt", "^o\\d"] }`
 * Missing fields fall back to the locked defaults (mode `auto`, id patterns
 * `DEFAULT_GPT_ID_PATTERNS`). A malformed file falls back to defaults too —
 * the gate never throws on bad config.
 */
export function loadConfig(): ApplyPatchConfig {
  if (cachedConfig) return cachedConfig;

  let mode: FeatureMode = "auto";
  let patterns: readonly RegExp[] = DEFAULT_GPT_ID_PATTERNS;
  try {
    const path = join(homedir(), ".pi", "agent", "pi-apply-patch.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        mode?: unknown;
        gptIdPatterns?: unknown;
      };
      if (parsed.mode === "on" || parsed.mode === "off" || parsed.mode === "auto") {
        mode = parsed.mode;
      }
      if (parsed.gptIdPatterns !== undefined) {
        patterns = compilePatterns(parsed.gptIdPatterns);
      }
    }
  } catch {
    // Fall back to defaults on any read/parse error.
  }
  cachedConfig = { mode, gptIdPatterns: patterns };
  return cachedConfig;
}

/** Invalidate the cache (used by tests and reload-driven re-reads). */
export function resetConfigCache(): void {
  cachedConfig = undefined;
}

/**
 * Test-only injection point: install a config as if it had been read from the
 * config file, bypassing disk. There is no runtime override channel — the
 * config file is the only one — so tests use this to exercise the `mode ===
 * "on" | "off"` branches without writing to the real `~/.pi/agent/` path.
 */
export function _setConfigForTesting(config: ApplyPatchConfig | null): void {
  cachedConfig = config === null ? undefined : config;
}

/** True when the model is a GPT-family model that should use apply_patch. */
export function isGptModel(
  model: Pick<GatableModel, "id" | "api"> | null | undefined,
  patterns: readonly RegExp[] = loadConfig().gptIdPatterns,
): boolean {
  if (!model) return false;
  // The Codex subscription API is unambiguously OpenAI-GPT territory.
  if (model.api === "openai-codex-responses") return true;
  const id = model.id ?? "";
  if (!id) return false;
  for (const re of patterns) {
    if (re.test(id)) return true;
  }
  return false;
}

/** Whether edit/write must be blocked (defense-in-depth on top of setActiveTools). */
export function shouldBlockEditWrite(model: Pick<GatableModel, "id" | "api"> | null | undefined): boolean {
  const { mode } = loadConfig();
  if (mode === "off") return false;
  if (mode === "on") return true;
  return isGptModel(model);
}

/**
 * Compute the desired active-tool set for the current model. Returns `null`
 * when nothing changes so the caller can skip the setActiveTools call.
 *
 * Invariant: only MANAGED_TOOLS are ever added/removed; every other tool the
 * user or other extensions enabled is preserved verbatim.
 */
export function desiredActiveTools(
  model: Pick<GatableModel, "id" | "api"> | null | undefined,
  currentActive: readonly string[],
): string[] | null {
  const { mode } = loadConfig();
  const keep = currentActive.filter((name) => !managedSet.has(name));
  const gpt = mode === "on" || (mode === "auto" && isGptModel(model));
  // mode === "off", or auto+non-GPT -> restore edit/write, hide apply_patch.
  const desired = gpt ? ["apply_patch"] : ["edit", "write"];
  const next = [...keep, ...desired];

  const currentSorted = [...currentActive].sort().join("\0");
  const nextSorted = [...next].sort().join("\0");
  if (currentSorted === nextSorted) return null;
  return next;
}
