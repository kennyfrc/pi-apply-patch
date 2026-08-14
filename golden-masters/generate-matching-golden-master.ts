// Regenerates corpus/apply-patch.matching.golden.txt from the package engine.
// Mirrors pi-mono-kenn-dev .../apply-patch/generate-matching-golden-master.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runApplyPatchMatchingCharacterization } from "../../packages/pi-apply-patch/src/matching-characterization.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(currentDir, "corpus");
const fixturePath = join(corpusDir, "apply-patch.matching.golden.txt");

const output = await runApplyPatchMatchingCharacterization();
await mkdir(corpusDir, { recursive: true });
await writeFile(fixturePath, output, "utf8");

console.log(`Wrote matching golden master to ${fixturePath}`);
