/**
 * pi-apply-patch — OpenAI Codex `apply_patch` file-editing tool for Pi, active
 * only for GPT-family models, where it replaces the built-in `edit` and
 * `write` tools.
 *
 * Golden master: golden-masters/ freezes the engine behavior.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasTerminalUi } from "pi-portable-ui";
import { applyPatchTool } from "./tool.js";
import {
  desiredActiveTools,
  isGptModel,
  loadConfig,
  resetConfigCache,
  shouldBlockEditWrite,
} from "./gate.js";

const STATUS_KEY = "pi-apply-patch";

function describeMode(ctx: ExtensionContext): string {
  const { mode } = loadConfig();
  if (mode === "off") return "apply_patch off";
  const gpt = isGptModel(ctx.model);
  return gpt ? "apply_patch on (GPT, edit/write disabled)" : "edit/write on";
}

/**
 * Apply the GPT/non-GPT tool swap. Reads the live active set, computes the
 * desired set (only MANAGED_TOOLS ever move), and calls setActiveTools when it
 * actually differs. Idempotent: a no-op when the set is already correct.
 */
function applyGating(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const current = pi.getActiveTools();
  const next = desiredActiveTools(ctx.model, current);
  if (!next) return;
  pi.setActiveTools(next);
  if (hasTerminalUi(ctx)) ctx.ui.setStatus(STATUS_KEY, describeMode(ctx));
}

export default function applyPatchExtension(pi: ExtensionAPI): void {
  // The tool is always registered so it can be toggled on manually; visibility
  // is controlled by the gating swap below.
  pi.registerTool(applyPatchTool);

  // Gating fires on startup and every model change. model_select covers
  // cycle/restore; session_start covers the initial model and the "reload"
  // path (where the config cache is reset so edits apply without restart).
  pi.on("session_start", (_event, ctx) => {
    resetConfigCache();
    applyGating(pi, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  // Defense in depth: even if edit/write somehow stay in the active set for a
  // GPT model (a slow setActiveTools refresh, another extension re-adding
  // them, or an SDK customTools entry), block the call and point the model at
  // apply_patch. Mirrors pi-argv-tools' projector pattern (tool_result →
  // isError), but applied at tool_call where blocking is supported.
  pi.on("tool_call", (event, ctx) => {
    if (!shouldBlockEditWrite(ctx.model)) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true as const,
        reason:
          "apply_patch is the active file-editing tool for this GPT model. Use apply_patch with a *** Begin Patch / *** End Patch payload instead of edit or write.",
      };
    }
    return undefined;
  });

  pi.on("session_shutdown", () => {
    resetConfigCache();
  });
}

// Re-exported for tests / programmatic use.
export { applyPatchTool } from "./tool.js";
export {
  desiredActiveTools,
  isGptModel,
  loadConfig,
  resetConfigCache,
  shouldBlockEditWrite,
  MANAGED_TOOLS,
  type ApplyPatchConfig,
  type FeatureMode,
  type GatableModel,
} from "./gate.js";
export { applyPatchParameters, type ApplyPatchToolDetails, type ApplyPatchUndoEntry } from "./tool.js";
