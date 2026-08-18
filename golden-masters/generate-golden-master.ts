// Regenerates corpus/apply-patch.golden.txt from the package engine.
// Mirrors the original characterization generator in the reference implementation.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runApplyPatchCharacterization } from "../../packages/pi-apply-patch/src/characterization.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(currentDir, "corpus");
const fixturePath = join(corpusDir, "apply-patch.golden.txt");

const output = await runApplyPatchCharacterization();
await mkdir(corpusDir, { recursive: true });
await writeFile(fixturePath, output, "utf8");

console.log(`Wrote golden master to ${fixturePath}`);
