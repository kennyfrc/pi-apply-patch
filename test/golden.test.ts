import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runApplyPatchCharacterization } from "../src/characterization.js";
import { runApplyPatchMatchingCharacterization } from "../src/matching-characterization.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(currentDir, "..", "golden-masters", "corpus");
const endToEndGolden = join(corpusDir, "apply-patch.golden.txt");
const matchingGolden = join(corpusDir, "apply-patch.matching.golden.txt");

describe("apply_patch engine golden master", () => {
  // End-to-end: add/update/move/delete over a sandbox. This is the acceptance
  // test for the whole port — a single differing byte fails it.
  it("end-to-end characterization matches the golden corpus byte-for-byte", async () => {
    const output = await runApplyPatchCharacterization();
    const golden = await readFile(endToEndGolden, "utf8");
    expect(output).toBe(golden);
  }, 30000);

  // Matching: every seek tier (exact/trimEnd/trim/confusable/invisible/
  // whitespace/unescaped/fuzzy/context/eof/missing) with full traces.
  it("matching-tier characterization matches the golden corpus byte-for-byte", async () => {
    const output = await runApplyPatchMatchingCharacterization();
    const golden = await readFile(matchingGolden, "utf8");
    expect(output).toBe(golden);
  }, 30000);
});
