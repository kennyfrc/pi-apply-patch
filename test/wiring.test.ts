import { describe, expect, it } from "vitest";
import applyPatchExtension from "../src/index.js";

describe("pi-apply-patch wiring", () => {
  it("does not set terminal status in RPC mode", () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const pi = {
      registerTool: () => {},
      on: (name: string, fn: (event: unknown, ctx: any) => void) => handlers.set(name, fn),
      getActiveTools: () => ["read", "edit", "write"],
      setActiveTools: () => {},
    };
    applyPatchExtension(pi as never);
    expect(() => handlers.get("session_start")?.({}, {
      mode: "rpc",
      hasUI: true,
      model: { id: "gpt-5", provider: "openai", api: "openai-responses" },
      ui: { setStatus: () => { throw new Error("setStatus must be TUI-only"); } },
    })).not.toThrow();
  });
});
