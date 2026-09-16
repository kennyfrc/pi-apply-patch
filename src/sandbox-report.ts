import { readFile } from "node:fs/promises";
import { join } from "node:path";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

async function readFileIfExists(path: string): Promise<string | null> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

export function formatStream(stream: string | null): string {
    if (!stream) {
        return "<empty>";
    }
    if (stream.length === 0) {
        return "<empty>";
    }
    const normalized = stream.replace(/\r\n/g, "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

export async function formatState(root: string, paths: string[]): Promise<string[]> {
    const lines: string[] = [];
    for (const relativePath of paths) {
        const fullPath = join(root, relativePath);
        const contents = await readFileIfExists(fullPath);
        if (contents === null) {
            lines.push(`- ${relativePath}: <missing>`);
        } else {
            lines.push(`- ${relativePath}: ${JSON.stringify(contents)}`);
        }
    }
    return lines;
}