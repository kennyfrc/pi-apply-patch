import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runApplyPatchCharacterizationWithRunner } from "../src/characterization.js";
import type { ApplyPatchRunOptions, ApplyPatchRunResult } from "../src/runner.js";
import { applyPatchTool } from "../src/tool.js";

// Ported from pi-mono-kenn-dev .../apply-patch.tool.test.ts. Runs the actual
// tool (not the raw engine) through the characterization harness and checks
// it produces the same golden output — proving the ToolDefinition glue
// (ctx.cwd resolution, content extraction, error→exitCode mapping) preserves
// engine behavior.

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  currentDir,
  "..", "golden-masters",
  "corpus",
  "apply-patch.golden.txt",
);

async function runApplyPatchTool(options: ApplyPatchRunOptions): Promise<ApplyPatchRunResult> {
  // The pi tool takes cwd from ctx; no process.chdir needed (unlike the
  // source, which used process.cwd() because it had no ctx).
  const ctx = { cwd: options.cwd } as unknown as ExtensionContext;
  try {
    const result = await applyPatchTool.execute("test", { input: options.patch }, options.signal, undefined, ctx);
    const stdout = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

describe("apply_patch tool", () => {
  it("matches the golden master output when run through the characterization harness", async () => {
    const output = await runApplyPatchCharacterizationWithRunner(runApplyPatchTool);
    const golden = await readFile(fixturePath, "utf8");
    expect(output).toBe(golden);
  }, 30000);

  it("returns versioned bounded details without embedding file snapshots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-details-"));
    try {
      await writeFile(join(cwd, "large.txt"), `${"x".repeat(100_000)}\n`, "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: large.txt",
        "@@",
        `-${"x".repeat(100_000)}`,
        `+${"y".repeat(100_000)}`,
        "*** End Patch",
        "",
      ].join("\n");
      const result = await applyPatchTool.execute(
        "bounded",
        { input: patch },
        undefined,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(result.details).toEqual({
        v: 1,
        parsed: { ops: [{ type: "update", path: "large.txt" }], deletedPaths: [] },
      });
      expect(JSON.stringify(result.details).length).toBeLessThan(512);
      expect(JSON.stringify(result.details)).not.toContain("beforeContent");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
