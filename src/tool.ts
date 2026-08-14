/**
 * apply_patch tool definition for Pi.
 *
 * The execute body (parse → runApplyPatchBinary) is ported from the JDC fork
 * packages/coding-agent/src/tools/apply-patch.ts) at commit
 * 20b3f0f5cdb542c65bf0b4275828dfae6359d79f. Only the host glue differs:
 * AgentTool -> pi ToolDefinition, @sinclair/typebox -> typebox, prompt is
 * inlined from ./prompt.ts, and cwd is taken from ctx (falling back to
 * process.cwd() to match the original characterization harness).
 */
import { type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  type ApplyPatchParseResult,
  parseApplyPatchInput,
} from "./parse.js";
import { runApplyPatchBinary } from "./runner.js";
import { APPLY_PATCH_DESCRIPTION } from "./prompt.js";

/** @deprecated apply_patch undo is journaled independently by pi-undo-redo. */
export type ApplyPatchUndoEntry = never;

export interface ApplyPatchToolDetails {
  v: 1;
  parsed: ApplyPatchParseResult;
}

export const applyPatchParameters = Type.Object({
  input: Type.String({ description: "The entire contents of the apply_patch command" }),
});

type ApplyPatchParameters = Static<typeof applyPatchParameters>;

function cwdFromContext(ctx: ExtensionContext | undefined): string {
  return ctx?.cwd ?? process.cwd();
}

export const applyPatchTool: ToolDefinition<typeof applyPatchParameters, ApplyPatchToolDetails> = {
  name: "apply_patch",
  label: "apply_patch",
  description: APPLY_PATCH_DESCRIPTION,
  promptSnippet: "Apply Codex-style structured patch edits to files (Add/Delete/Update + Move + @@ hunks)",
  promptGuidelines: [
    "Use apply_patch for file edits when it is active: provide the full patch text in the input field, including *** Begin Patch / *** End Patch and Add/Delete/Update headers.",
    "With apply_patch active, prefer it over edit and write for multi-file or multi-hunk changes; prefix every new line with +, including when creating a file.",
  ],
  parameters: applyPatchParameters,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { input }: ApplyPatchParameters = params;
    const cwd = cwdFromContext(ctx);
    const parsed = parseApplyPatchInput(input);

    const result = await runApplyPatchBinary({
      patch: input,
      cwd,
      signal,
    });

    if (result.exitCode !== 0 && result.exitCode !== null) {
      const combined = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
      const message = combined.length > 0 ? combined : `apply_patch failed with code ${result.exitCode}`;
      throw new Error(message);
    }

    const output = result.stdout;

    return {
      content: [{ type: "text", text: output.length > 0 ? output : "(no output)" }],
      details: {
        v: 1,
        parsed,
      },
    };
  },
};
