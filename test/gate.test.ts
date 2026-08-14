import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyPatchConfig, GatableModel } from "../src/gate.js";
import {
  DEFAULT_GPT_ID_PATTERNS,
  _setConfigForTesting,
  desiredActiveTools,
  isGptModel,
  loadConfig,
  resetConfigCache,
  shouldBlockEditWrite,
} from "../src/gate.js";

function model(id: string, api = "openai-responses", provider = "openai"): GatableModel {
  return { id, api, provider };
}

const AUTO: ApplyPatchConfig = { mode: "auto", gptIdPatterns: DEFAULT_GPT_ID_PATTERNS };

beforeEach(() => {
  // Hermetic: every test starts with the locked default config, ignoring any
  // real ~/.pi/agent/pi-apply-patch.json that happens to exist on the machine.
  _setConfigForTesting(AUTO);
});

afterEach(() => {
  resetConfigCache();
});

describe("isGptModel (locked default predicate)", () => {
  it("matches gpt-* ids", () => {
    expect(isGptModel(model("gpt-5"))).toBe(true);
    expect(isGptModel(model("gpt-4o"))).toBe(true);
    expect(isGptModel(model("gpt-4.1"))).toBe(true);
    expect(isGptModel(model("gpt-5-codex"))).toBe(true);
  });

  it("matches o-series ids (o1/o3/o4)", () => {
    expect(isGptModel(model("o1"))).toBe(true);
    expect(isGptModel(model("o3"))).toBe(true);
    expect(isGptModel(model("o4-mini"))).toBe(true);
    expect(isGptModel(model("o1-pro"))).toBe(true);
  });

  it("matches openai-codex-responses api regardless of id", () => {
    expect(isGptModel(model("codex-1", "openai-codex-responses"))).toBe(true);
  });

  it("excludes non-GPT models (router-robust)", () => {
    // Default model in settings.json — a GLM model over an OpenAI-compatible router.
    expect(isGptModel(model("glm-5.2-short", "openai-completions", "neuralwatt"))).toBe(false);
    expect(isGptModel(model("claude-sonnet-4-5", "anthropic-messages", "anthropic"))).toBe(false);
    expect(isGptModel(model("gemini-2.5-pro", "google-generative-ai", "google"))).toBe(false);
    // An id that merely starts with "o" but is not o-series (e.g. "openai").
    expect(isGptModel(model("openai-mini", "openai-responses"))).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isGptModel(null)).toBe(false);
    expect(isGptModel(undefined)).toBe(false);
  });

  it("honors custom id patterns", () => {
    // Caller-supplied patterns replace the defaults entirely.
    expect(isGptModel(model("qwen3-coder"), [/^qwen/i])).toBe(true);
    expect(isGptModel(model("gpt-5"), [/^qwen/i])).toBe(false);
  });
});

describe("desiredActiveTools (tool-swap invariant)", () => {
  it("GPT model: removes edit/write, adds apply_patch, keeps everything else", () => {
    const next = desiredActiveTools(model("gpt-5"), ["read", "bash", "edit", "write", "todo_write"]);
    expect(next).toEqual(["read", "bash", "todo_write", "apply_patch"]);
  });

  it("non-GPT model: removes apply_patch, restores edit/write, keeps everything else", () => {
    const next = desiredActiveTools(model("glm-5.2-short"), ["read", "bash", "apply_patch", "todo_write"]);
    expect(next).toEqual(["read", "bash", "todo_write", "edit", "write"]);
  });

  it("non-GPT model keeps edit/write already present (no duplication)", () => {
    const next = desiredActiveTools(model("glm-5.2-short"), ["read", "edit", "write"]);
    expect(next).toBeNull(); // already correct
  });

  it("GPT model already on apply_patch returns null (idempotent)", () => {
    const next = desiredActiveTools(model("gpt-5"), ["read", "bash", "apply_patch"]);
    expect(next).toBeNull();
  });

  it("mode=on forces GPT-mode for a non-GPT model", () => {
    _setConfigForTesting({ mode: "on", gptIdPatterns: DEFAULT_GPT_ID_PATTERNS });
    const next = desiredActiveTools(model("glm-5.2-short"), ["read", "edit", "write"]);
    expect(next).toEqual(["read", "apply_patch"]);
  });

  it("mode=off forces edit/write for a GPT model", () => {
    _setConfigForTesting({ mode: "off", gptIdPatterns: DEFAULT_GPT_ID_PATTERNS });
    const next = desiredActiveTools(model("gpt-5"), ["read", "apply_patch"]);
    expect(next).toEqual(["read", "edit", "write"]);
  });

  it("never touches tools outside the managed set", () => {
    const next = desiredActiveTools(model("gpt-5"), ["read", "bash", "web_search", "edit", "my_custom_tool"]);
    expect(next).toEqual(["read", "bash", "web_search", "my_custom_tool", "apply_patch"]);
  });
});

describe("shouldBlockEditWrite (defense-in-depth)", () => {
  it("blocks for GPT models in auto mode", () => {
    expect(shouldBlockEditWrite(model("gpt-5"))).toBe(true);
  });

  it("does not block for non-GPT models in auto mode", () => {
    expect(shouldBlockEditWrite(model("glm-5.2-short", "openai-completions", "neuralwatt"))).toBe(false);
  });

  it("mode=on blocks even for non-GPT", () => {
    _setConfigForTesting({ mode: "on", gptIdPatterns: DEFAULT_GPT_ID_PATTERNS });
    expect(shouldBlockEditWrite(model("glm-5.2-short"))).toBe(true);
  });

  it("mode=off never blocks, even for GPT", () => {
    _setConfigForTesting({ mode: "off", gptIdPatterns: DEFAULT_GPT_ID_PATTERNS });
    expect(shouldBlockEditWrite(model("gpt-5"))).toBe(false);
  });
});

describe("loadConfig (config-file-only)", () => {
  it("falls back to defaults when no config is loaded", () => {
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.mode).toBe("auto");
    expect(cfg.gptIdPatterns).toBe(DEFAULT_GPT_ID_PATTERNS);
  });

  it("respects a config injected as if read from the file", () => {
    _setConfigForTesting({ mode: "on", gptIdPatterns: [/^qwen/i] });
    expect(loadConfig().mode).toBe("on");
    expect(isGptModel(model("qwen3-coder"))).toBe(true);
    resetConfigCache();
    expect(loadConfig().mode).toBe("auto");
  });
});
