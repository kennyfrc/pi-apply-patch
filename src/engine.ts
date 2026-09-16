import { constants } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

const HEREDOC_STARTS = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);

const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201C": '"',
    "\u201D": '"',
    "\u201A": "'",
    "\u201E": '"',
    "\u00AB": '"',
    "\u00BB": '"',
    "\u2039": "'",
    "\u203A": "'",
    "\u2013": "-",
    "\u2014": "-",
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2015": "-",
    "\u2212": "-",
    "\u00A0": " ",
    "\u2002": " ",
    "\u2003": " ",
    "\u2004": " ",
    "\u2005": " ",
    "\u2006": " ",
    "\u2007": " ",
    "\u2008": " ",
    "\u2009": " ",
    "\u200A": " ",
    "\u202F": " ",
    "\u205F": " ",
    "\u3000": " ",
    "\u2024": ".",
    "\uFF0E": ".",
    "\uFF0C": ",",
};

const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
    "\u200B",
    "\u200C",
    "\u200D",
    "\u200E",
    "\u200F",
    "\uFEFF",
    "\u2060",
]);

const FUZZY_MATCH_THRESHOLD = 0.8;

export interface ApplyPatchRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface ApplyPatchTrace {
    log: (line: string) => void;
}

interface ApplyPatchArgs {
    patch: string;
    hunks: Hunk[];
}

interface UpdateFileChunk {
    changeContext: string | null;
    oldLines: string[];
    newLines: string[];
    isEndOfFile: boolean;
}

interface AddFileHunk {
    type: "add";
    path: string;
    contents: string;
}

interface DeleteFileHunk {
    type: "delete";
    path: string;
}

interface UpdateFileHunk {
    type: "update";
    path: string;
    movePath: string | null;
    chunks: UpdateFileChunk[];
}

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type Replacement = [startIndex: number, oldLen: number, newLines: string[]];

class ApplyPatchParseError extends Error {
    readonly kind: "invalid_patch" | "invalid_hunk";
    readonly lineNumber?: number;

    constructor(kind: "invalid_patch" | "invalid_hunk", message: string, lineNumber?: number) {
        super(message);
        this.kind = kind;
        if (lineNumber !== undefined) this.lineNumber = lineNumber;
    }
}

class ApplyPatchComputeError extends Error {}

class ApplyPatchIoError extends Error {}

interface AffectedPaths {
    added: string[];
    modified: string[];
    deleted: string[];
}

function traceLine(trace: ApplyPatchTrace | undefined, line: string): void {
    if (!trace) {
        return;
    }
    const sanitized = line.replace(/\r?\n/g, "\\n");
    trace.log(sanitized);
}

function normalizeConfusables(input: string): string {
    let result = input;
    for (const char of INVISIBLE_CHARS) {
        result = result.split(char).join("");
    }
    for (const [from, to] of Object.entries(CONFUSABLE_MAP)) {
        result = result.split(from).join(to);
    }
    return result;
}

function normalizeWhitespace(input: string): string {
    return normalizeConfusables(input).replace(/\s+/g, " ").trim();
}

function unescapeString(input: string): string {
    return input.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured) => {
        switch (captured) {
            case "n":
                return "\n";
            case "t":
                return "\t";
            case "r":
                return "\r";
            case "'":
                return "'";
            case '"':
                return '"';
            case "`":
                return "`";
            case "\\":
                return "\\";
            case "\n":
                return "\n";
            case "$":
                return "$";
            default:
                return match;
        }
    });
}

function stripCommonIndent(lines: string[]): string[] {
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
        return lines;
    }
    const minIndent = Math.min(
        ...nonEmptyLines.map((line) => {
            const match = line.match(/^(\s*)/);
            return match?.[1]?.length ?? 0;
        }),
    );
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)));
}

function expandPath(filePath: string): string {
    if (filePath === "~") {
        return os.homedir();
    }
    if (filePath.startsWith("~/")) {
        return os.homedir() + filePath.slice(1);
    }
    return filePath;
}

async function resolvePathWithinCwd(
    cwd: string,
    target: string,
    createParents: boolean,
    trace?: ApplyPatchTrace,
): Promise<string> {
    const expandedTarget = expandPath(target);
    if (isAbsolute(expandedTarget)) {
        if (createParents) {
            await mkdir(dirname(expandedTarget), { recursive: true });
        }
        traceLine(trace, `path_check: target=${target} status=absolute`);
        return expandedTarget;
    }

    const resolved = resolve(cwd, expandedTarget);
    if (createParents) {
        await mkdir(dirname(resolved), { recursive: true });
    }
    traceLine(trace, `path_check: target=${target} status=ok`);
    return resolved;
}

async function writeFileExclusive(path: string, contents: string): Promise<void> {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    const handle = await open(path, flags, 0o666);
    try {
        await handle.writeFile(contents, "utf8");
    } finally {
        await handle.close();
    }
}

async function writeFileReplace(path: string, contents: string): Promise<void> {
    const flags = constants.O_WRONLY | constants.O_TRUNC;
    const handle = await open(path, flags, 0o666);
    try {
        await handle.writeFile(contents, "utf8");
    } finally {
        await handle.close();
    }
}

function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) =>
        Array.from({ length: a.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );

    for (let j = 1; j <= b.length; j += 1) {
        for (let i = 1; i <= a.length; i += 1) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j]![i] = Math.min(matrix[j]![i - 1]! + 1, matrix[j - 1]![i]! + 1, matrix[j - 1]![i - 1]! + indicator);
        }
    }

    return matrix[b.length]![a.length]!;
}

function lineSimilarity(a: string, b: string): number {
    const normalizedA = normalizeConfusables(a).trim();
    const normalizedB = normalizeConfusables(b).trim();
    const maxLen = Math.max(normalizedA.length, normalizedB.length);
    if (maxLen === 0) {
        return 1;
    }
    const distance = levenshteinDistance(normalizedA, normalizedB);
    return 1 - distance / maxLen;
}

function ensureTrailingNewline(value: string): string {
    if (value.length === 0) {
        return value;
    }
    return value.endsWith("\n") ? value : `${value}\n`;
}

function splitPatchLines(patch: string): string[] {
    const trimmed = patch.trim();
    if (trimmed.length === 0) {
        return [];
    }
    return trimmed.split(/\r?\n/);
}

function checkPatchBoundariesStrict(lines: string[]): void {
    const first = lines[0];
    const last = lines[lines.length - 1];
    const firstLine = first?.trim() ?? null;
    const lastLine = last?.trim() ?? null;

    if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) {
        return;
    }
    if (firstLine && firstLine !== BEGIN_PATCH_MARKER) {
        throw new ApplyPatchParseError("invalid_patch", "The first line of the patch must be '*** Begin Patch'");
    }
    throw new ApplyPatchParseError("invalid_patch", "The last line of the patch must be '*** End Patch'");
}

function checkPatchBoundariesLenient(lines: string[], originalError: ApplyPatchParseError): string[] {
    if (lines.length >= 4) {
        const first = lines[0];
        const last = lines[lines.length - 1];
        if (first !== undefined && last !== undefined && HEREDOC_STARTS.has(first) && last.endsWith("EOF")) {
            const innerLines = lines.slice(1, -1);
            checkPatchBoundariesStrict(innerLines);
            return innerLines;
        }
    }
    throw originalError;
}

function parsePatchText(patch: string, trace?: ApplyPatchTrace): ApplyPatchArgs {
    traceLine(trace, `parse_patch: raw_length=${patch.length}`);
    const lines = splitPatchLines(patch);
    traceLine(trace, `parse_patch: lines=${lines.length}`);
    let patchLines = lines;
    try {
        checkPatchBoundariesStrict(lines);
        traceLine(trace, "parse_patch: boundaries=strict");
    } catch (error) {
        if (error instanceof ApplyPatchParseError) {
            patchLines = checkPatchBoundariesLenient(lines, error);
            traceLine(trace, "parse_patch: boundaries=lenient");
        } else {
            throw error;
        }
    }

    const hunks: Hunk[] = [];
    const lastLineIndex = patchLines.length - 1;
    let remainingLines = patchLines.slice(1, lastLineIndex);
    let lineNumber = 2;
    while (remainingLines.length > 0) {
        const { hunk, linesParsed } = parseOneHunk(remainingLines, lineNumber, trace);
        hunks.push(hunk);
        lineNumber += linesParsed;
        remainingLines = remainingLines.slice(linesParsed);
    }

    traceLine(trace, `parse_patch: hunks=${hunks.length}`);
    return {
        patch: patchLines.join("\n"),
        hunks,
    };
}

type ParsedHunk = { hunk: Hunk; linesParsed: number };

type HunkParser = (firstLine: string, lines: string[], lineNumber: number, trace?: ApplyPatchTrace) => ParsedHunk;

function parseAddFileHunk(
    firstLine: string,
    lines: string[],
    _lineNumber: number,
    trace?: ApplyPatchTrace,
): ParsedHunk {
    const path = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let parsedLines = 1;
    for (const addLine of lines.slice(1)) {
        if (addLine.startsWith("+")) {
            contents += `${addLine.slice(1)}\n`;
            parsedLines += 1;
        } else {
            break;
        }
    }
    traceLine(trace, `hunk:add path=${path} lines=${parsedLines - 1}`);
    return {
        hunk: { type: "add", path, contents },
        linesParsed: parsedLines,
    };
}

function parseDeleteFileHunk(
    firstLine: string,
    _lines: string[],
    _lineNumber: number,
    trace?: ApplyPatchTrace,
): ParsedHunk {
    const path = firstLine.slice(DELETE_FILE_MARKER.length);
    traceLine(trace, `hunk:delete path=${path}`);
    return { hunk: { type: "delete", path }, linesParsed: 1 };
}

function parseUpdateFileHunk(
    firstLine: string,
    lines: string[],
    lineNumber: number,
    trace?: ApplyPatchTrace,
): ParsedHunk {
    const path = firstLine.slice(UPDATE_FILE_MARKER.length);
    let remainingLines = lines.slice(1);
    let parsedLines = 1;

    let movePath: string | null = null;
    const firstRemaining = remainingLines[0];
    if (firstRemaining?.startsWith(MOVE_TO_MARKER)) {
        movePath = firstRemaining.slice(MOVE_TO_MARKER.length);
        remainingLines = remainingLines.slice(1);
        parsedLines += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remainingLines.length > 0) {
        const next = remainingLines[0];
        if (next === undefined) break;
        if (next.trim().length === 0) {
            parsedLines += 1;
            remainingLines = remainingLines.slice(1);
            continue;
        }
        if (next.startsWith("***")) {
            break;
        }

        const { chunk, linesParsed } = parseUpdateFileChunk(
            remainingLines,
            lineNumber + parsedLines,
            chunks.length === 0,
            trace,
        );
        chunks.push(chunk);
        parsedLines += linesParsed;
        remainingLines = remainingLines.slice(linesParsed);
    }

    if (chunks.length === 0) {
        throw new ApplyPatchParseError("invalid_hunk", `Update file hunk for path '${path}' is empty`, lineNumber);
    }

    traceLine(trace, `hunk:update path=${path} move=${movePath ?? "<none>"} chunks=${chunks.length}`);
    return {
        hunk: { type: "update", path, movePath, chunks },
        linesParsed: parsedLines,
    };
}

// One row per hunk header; a new hunk kind is a row plus its parser, not
// another arm in the reader.
const HUNK_PARSERS: ReadonlyArray<{ marker: string; parse: HunkParser }> = [
    { marker: ADD_FILE_MARKER, parse: parseAddFileHunk },
    { marker: DELETE_FILE_MARKER, parse: parseDeleteFileHunk },
    { marker: UPDATE_FILE_MARKER, parse: parseUpdateFileHunk },
];

function parseOneHunk(
    lines: string[],
    lineNumber: number,
    trace?: ApplyPatchTrace,
): ParsedHunk {
    const firstLine = lines[0]?.trim() ?? "";
    for (const header of HUNK_PARSERS) {
        if (firstLine.startsWith(header.marker)) {
            return header.parse(firstLine, lines, lineNumber, trace);
        }
    }

    throw new ApplyPatchParseError(
        "invalid_hunk",
        `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        lineNumber,
    );
}

function readChunkHeader(
    lines: string[],
    lineNumber: number,
    allowMissingContext: boolean,
): { changeContext: string | null; startIndex: number } {
    const firstLine = lines[0];
    if (firstLine === undefined || firstLine === EMPTY_CHANGE_CONTEXT_MARKER) {
        return { changeContext: null, startIndex: 1 };
    }
    if (firstLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        return { changeContext: firstLine.slice(CHANGE_CONTEXT_MARKER.length), startIndex: 1 };
    }
    if (!allowMissingContext) {
        throw new ApplyPatchParseError(
            "invalid_hunk",
            `Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
            lineNumber,
        );
    }
    return { changeContext: null, startIndex: 0 };
}

type ChunkLineReader = (chunk: UpdateFileChunk, line: string) => void;

// Keyed by the line's first character. "" is the blank line, which contributes
// an empty line to both sides of the diff.
const CHUNK_LINE_READERS: Readonly<Record<string, ChunkLineReader>> = {
    "": (chunk) => {
        chunk.oldLines.push("");
        chunk.newLines.push("");
    },
    " ": (chunk, line) => {
        chunk.oldLines.push(line.slice(1));
        chunk.newLines.push(line.slice(1));
    },
    "+": (chunk, line) => {
        chunk.newLines.push(line.slice(1));
    },
    "-": (chunk, line) => {
        chunk.oldLines.push(line.slice(1));
    },
};

function readChunkBody(
    chunk: UpdateFileChunk,
    bodyLines: string[],
    lineNumber: number,
): number {
    let parsedLines = 0;
    for (const line of bodyLines) {
        if (line === EOF_MARKER) {
            if (parsedLines === 0) {
                throw new ApplyPatchParseError("invalid_hunk", "Update hunk does not contain any lines", lineNumber + 1);
            }
            chunk.isEndOfFile = true;
            return parsedLines + 1;
        }

        const reader = CHUNK_LINE_READERS[line[0] ?? ""];
        if (reader === undefined) {
            if (parsedLines === 0) {
                throw new ApplyPatchParseError(
                    "invalid_hunk",
                    `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
                    lineNumber + 1,
                );
            }
            return parsedLines;
        }
        reader(chunk, line);
        parsedLines += 1;
    }
    return parsedLines;
}

function parseUpdateFileChunk(
    lines: string[],
    lineNumber: number,
    allowMissingContext: boolean,
    trace?: ApplyPatchTrace,
): { chunk: UpdateFileChunk; linesParsed: number } {
    if (lines.length === 0) {
        throw new ApplyPatchParseError("invalid_hunk", "Update hunk does not contain any lines", lineNumber);
    }

    const { changeContext, startIndex } = readChunkHeader(lines, lineNumber, allowMissingContext);
    if (startIndex >= lines.length) {
        throw new ApplyPatchParseError("invalid_hunk", "Update hunk does not contain any lines", lineNumber + 1);
    }

    const chunk: UpdateFileChunk = {
        changeContext,
        oldLines: [],
        newLines: [],
        isEndOfFile: false,
    };

    const parsedLines = readChunkBody(chunk, lines.slice(startIndex), lineNumber) + startIndex;
    traceLine(
        trace,
        `chunk: context=${changeContext ?? "<none>"} old=${chunk.oldLines.length} new=${chunk.newLines.length} eof=${chunk.isEndOfFile} parsed=${parsedLines}`,
    );
    return { chunk, linesParsed: parsedLines };
}

type LineComparator = (line: string, patternLine: string) => boolean;

type LineNormalizer = (line: string) => string;

function arraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) {
            return false;
        }
    }
    return true;
}

function findSequenceWithComparator(
    lines: string[],
    pattern: string[],
    searchStart: number,
    lastIndex: number,
    compare: LineComparator,
): number | null {
    for (let i = searchStart; i <= lastIndex; i += 1) {
        let ok = true;
        for (let p = 0; p < pattern.length; p += 1) {
            if (!compare(lines[i + p]!, pattern[p]!)) {
                ok = false;
                break;
            }
        }
        if (ok) {
            return i;
        }
    }
    return null;
}

function findSequenceWithNormalizer(
    lines: string[],
    patternNormalized: string[],
    searchStart: number,
    lastIndex: number,
    normalizeLine: LineNormalizer,
): number | null {
    for (let i = searchStart; i <= lastIndex; i += 1) {
        let ok = true;
        for (let p = 0; p < patternNormalized.length; p += 1) {
            if (normalizeLine(lines[i + p]!) !== patternNormalized[p]!) {
                ok = false;
                break;
            }
        }
        if (ok) {
            return i;
        }
    }
    return null;
}

function findSequenceWithIndentation(
    lines: string[],
    pattern: string[],
    searchStart: number,
    lastIndex: number,
): number | null {
    const normalizedPattern = stripCommonIndent(pattern.map((line) => normalizeConfusables(line)));
    for (let i = searchStart; i <= lastIndex; i += 1) {
        const window = lines.slice(i, i + pattern.length).map((line) => normalizeConfusables(line));
        const normalizedWindow = stripCommonIndent(window);
        if (arraysEqual(normalizedWindow, normalizedPattern)) {
            return i;
        }
    }
    return null;
}

function findSequenceFuzzy(
    lines: string[],
    pattern: string[],
    searchStart: number,
    lastIndex: number,
): { index: number | null; score: number } {
    let bestIndex: number | null = null;
    let bestScore = -1;

    for (let i = searchStart; i <= lastIndex; i += 1) {
        let scoreSum = 0;
        for (let p = 0; p < pattern.length; p += 1) {
            scoreSum += lineSimilarity(lines[i + p]!, pattern[p]!);
        }
        const score = scoreSum / pattern.length;
        if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
        }
    }

    if (bestScore >= FUZZY_MATCH_THRESHOLD) {
        return { index: bestIndex, score: bestScore };
    }
    return { index: null, score: bestScore };
}

type SeekOutcome =
    | { readonly status: "found"; readonly index: number; readonly detail?: string }
    | { readonly status: "missed"; readonly detail?: string }
    | { readonly status: "skipped" };

interface SeekStrategy {
    readonly key: string;
    readonly find: () => SeekOutcome;
}

function toOutcome(index: number | null): SeekOutcome {
    return index === null ? { status: "missed" } : { status: "found", index };
}

function seekTraceLine(key: string, outcome: SeekOutcome): string {
    switch (outcome.status) {
        case "found":
            return `seek:${key}=${outcome.index}${outcome.detail ?? ""}`;
        case "missed":
            return `seek:${key}=none${outcome.detail ?? ""}`;
        case "skipped":
            return `seek:${key}=skipped`;
    }
}

function seekUnescaped(
    lines: string[],
    pattern: string[],
    searchStart: number,
    lastIndex: number,
): SeekOutcome {
    const unescapedPattern = pattern.map((line) => unescapeString(line));
    if (!unescapedPattern.some((line, index) => line !== pattern[index])) {
        return { status: "skipped" };
    }
    const normalizedLine = (line: string): string => normalizeConfusables(line).trim();
    return toOutcome(
        findSequenceWithNormalizer(lines, unescapedPattern.map(normalizedLine), searchStart, lastIndex, normalizedLine),
    );
}

function seekFuzzy(lines: string[], pattern: string[], searchStart: number, lastIndex: number): SeekOutcome {
    const result = findSequenceFuzzy(lines, pattern, searchStart, lastIndex);
    if (result.index === null) {
        return { status: "missed", detail: ` best=${result.score.toFixed(3)}` };
    }
    return { status: "found", index: result.index, detail: ` score=${result.score.toFixed(3)}` };
}

// The tolerances, most exact first. Order is the point: the first tier that
// finds a place wins, and each `key` is the name its trace line uses.
function seekStrategies(
    lines: string[],
    pattern: string[],
    searchStart: number,
    lastIndex: number,
): SeekStrategy[] {
    const compareWith = (compareLine: LineComparator): SeekOutcome =>
        toOutcome(findSequenceWithComparator(lines, pattern, searchStart, lastIndex, compareLine));
    const normalizeWith = (normalizeLine: LineNormalizer, patternLines: string[]): SeekOutcome =>
        toOutcome(
            findSequenceWithNormalizer(lines, patternLines.map(normalizeLine), searchStart, lastIndex, normalizeLine),
        );
    const normalizedLine = (line: string): string => normalizeConfusables(line).trim();
    return [
        { key: "exact", find: () => compareWith((line, target) => line === target) },
        { key: "trim_end", find: () => compareWith((line, target) => line.trimEnd() === target.trimEnd()) },
        { key: "trim", find: () => compareWith((line, target) => line.trim() === target.trim()) },
        { key: "unescaped", find: () => seekUnescaped(lines, pattern, searchStart, lastIndex) },
        { key: "normalised", find: () => normalizeWith(normalizedLine, pattern) },
        { key: "whitespace", find: () => normalizeWith(normalizeWhitespace, pattern) },
        { key: "indent", find: () => toOutcome(findSequenceWithIndentation(lines, pattern, searchStart, lastIndex)) },
        { key: "fuzzy", find: () => seekFuzzy(lines, pattern, searchStart, lastIndex) },
    ];
}

function seekSequence(
    lines: string[],
    pattern: string[],
    start: number,
    eof: boolean,
    trace?: ApplyPatchTrace,
): number | null {
    traceLine(trace, `seek:start=${start} eof=${eof} pattern=${JSON.stringify(pattern)}`);
    if (pattern.length === 0) {
        traceLine(trace, `seek:empty -> ${start}`);
        return start;
    }
    if (pattern.length > lines.length) {
        traceLine(trace, "seek:pattern_longer_than_lines");
        return null;
    }

    const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
    const lastIndex = lines.length - pattern.length;

    for (const strategy of seekStrategies(lines, pattern, searchStart, lastIndex)) {
        const outcome = strategy.find();
        traceLine(trace, seekTraceLine(strategy.key, outcome));
        if (outcome.status === "found") {
            return outcome.index;
        }
    }
    return null;
}

interface Insertion {
    readonly index: number;
    readonly mode: "eof" | "context";
}

interface MatchedSpan {
    readonly index: number;
    readonly length: number;
    readonly newLines: string[];
}

function seekChangeContext(
    lines: string[],
    changeContext: string,
    lineIndex: number,
    path: string,
    trace?: ApplyPatchTrace,
): number {
    const contextIndex = seekSequence(lines, [changeContext], lineIndex, false, trace);
    if (contextIndex === null) {
        throw new ApplyPatchComputeError(`Failed to find context '${changeContext}' in ${path}`);
    }
    traceLine(trace, `context_found: index=${contextIndex}`);
    return contextIndex + 1;
}

function resolveInsertion(chunk: UpdateFileChunk, lines: string[], lineIndex: number): Insertion {
    if (chunk.changeContext && !chunk.isEndOfFile) {
        return { index: Math.min(lineIndex, lines.length), mode: "context" };
    }
    const endIndex = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    return { index: endIndex, mode: "eof" };
}

function seekChunkOldLines(
    lines: string[],
    chunk: UpdateFileChunk,
    lineIndex: number,
    trace?: ApplyPatchTrace,
): MatchedSpan | null {
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile, trace);
    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
        pattern = pattern.slice(0, -1);
        if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
            newLines = newLines.slice(0, -1);
        }
        traceLine(trace, "pattern_trimmed_for_eof");
        found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile, trace);
    }
    if (found === null) {
        return null;
    }
    return { index: found, length: pattern.length, newLines };
}

function computeReplacements(
    originalLines: string[],
    path: string,
    chunks: UpdateFileChunk[],
    trace?: ApplyPatchTrace,
): Replacement[] {
    const replacements: Replacement[] = [];
    let lineIndex = 0;

    traceLine(trace, `compute_replacements: path=${path} chunks=${chunks.length} lines=${originalLines.length}`);

    for (const [chunkIndex, chunk] of chunks.entries()) {
        traceLine(
            trace,
            `compute_chunk: index=${chunkIndex} context=${chunk.changeContext ?? "<none>"} old=${chunk.oldLines.length} new=${chunk.newLines.length} eof=${chunk.isEndOfFile}`,
        );
        if (chunk.changeContext) {
            lineIndex = seekChangeContext(originalLines, chunk.changeContext, lineIndex, path, trace);
        }

        if (chunk.oldLines.length === 0) {
            const insertion = resolveInsertion(chunk, originalLines, lineIndex);
            replacements.push([insertion.index, 0, [...chunk.newLines]]);
            traceLine(trace, `insert_at: index=${insertion.index} mode=${insertion.mode} lines=${chunk.newLines.length}`);
            continue;
        }

        const span = seekChunkOldLines(originalLines, chunk, lineIndex, trace);
        if (span === null) {
            throw new ApplyPatchComputeError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
        }
        replacements.push([span.index, span.length, [...span.newLines]]);
        traceLine(trace, `match_found: index=${span.index} old_len=${span.length} new_len=${span.newLines.length}`);
        lineIndex = span.index + span.length;
    }

    replacements.sort((left, right) => left[0] - right[0]);
    traceLine(trace, `replacements_sorted: count=${replacements.length}`);
    return replacements;
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
    const updated = [...lines];
    for (let i = replacements.length - 1; i >= 0; i -= 1) {
        const replacement = replacements[i];
        if (replacement === undefined) continue;
        const [startIndex, oldLen, newLines] = replacement;
        for (let removal = 0; removal < oldLen; removal += 1) {
            if (startIndex < updated.length) {
                updated.splice(startIndex, 1);
            }
        }
        updated.splice(startIndex, 0, ...newLines);
    }
    return updated;
}

async function deriveNewContentsFromChunks(
    fsPath: string,
    displayPath: string,
    chunks: UpdateFileChunk[],
    trace?: ApplyPatchTrace,
): Promise<string> {
    let originalContents: string;
    try {
        originalContents = await readFile(fsPath, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ApplyPatchIoError(`Failed to read file to update ${displayPath}: ${message}`);
    }

    const originalLines = originalContents.split("\n");
    if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
        originalLines.pop();
    }
    traceLine(trace, `update_file: path=${displayPath} lines=${originalLines.length}`);

    const replacements = computeReplacements(originalLines, displayPath, chunks, trace);
    const newLines = applyReplacements(originalLines, replacements);
    if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
        newLines.push("");
    }
    return newLines.join("\n");
}

async function runFileOperation(operation: () => Promise<void>, failure: string): Promise<void> {
    try {
        await operation();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ApplyPatchIoError(`${failure}: ${message}`);
    }
}

async function applyAddHunk(hunk: AddFileHunk, cwd: string, trace?: ApplyPatchTrace): Promise<string> {
    traceLine(trace, `apply:add path=${hunk.path}`);
    const fullPath = await resolvePathWithinCwd(cwd, hunk.path, true, trace);
    await runFileOperation(() => writeFileExclusive(fullPath, hunk.contents), `Failed to write file ${hunk.path}`);
    return hunk.path;
}

async function applyDeleteHunk(hunk: DeleteFileHunk, cwd: string, trace?: ApplyPatchTrace): Promise<string> {
    traceLine(trace, `apply:delete path=${hunk.path}`);
    const fullPath = await resolvePathWithinCwd(cwd, hunk.path, false, trace);
    await runFileOperation(() => rm(fullPath), `Failed to delete file ${hunk.path}`);
    return hunk.path;
}

async function resolveMoveDestination(
    cwd: string,
    hunk: UpdateFileHunk,
    sourcePath: string,
    trace?: ApplyPatchTrace,
): Promise<string | null> {
    if (!hunk.movePath) {
        return null;
    }
    const movePath = await resolvePathWithinCwd(cwd, hunk.movePath, true, trace);
    if (movePath === sourcePath) {
        traceLine(trace, "move_path_same_as_source");
        return null;
    }
    return movePath;
}

async function applyUpdateHunk(hunk: UpdateFileHunk, cwd: string, trace?: ApplyPatchTrace): Promise<string> {
    traceLine(trace, `apply:update path=${hunk.path} move=${hunk.movePath ?? "<none>"}`);
    const sourcePath = await resolvePathWithinCwd(cwd, hunk.path, false, trace);
    const newContents = await deriveNewContentsFromChunks(sourcePath, hunk.path, hunk.chunks, trace);
    const movePath = await resolveMoveDestination(cwd, hunk, sourcePath, trace);
    if (movePath === null) {
        await runFileOperation(() => writeFileReplace(sourcePath, newContents), `Failed to write file ${hunk.path}`);
        return hunk.path;
    }
    await runFileOperation(
        () => writeFileExclusive(movePath, newContents),
        `Failed to write file ${hunk.movePath}`,
    );
    await runFileOperation(() => rm(sourcePath), `Failed to remove original ${hunk.path}`);
    return hunk.movePath ?? hunk.path;
}

function applyHunk(hunk: Hunk, cwd: string, trace?: ApplyPatchTrace): Promise<string> {
    switch (hunk.type) {
        case "add":
            return applyAddHunk(hunk, cwd, trace);
        case "delete":
            return applyDeleteHunk(hunk, cwd, trace);
        case "update":
            return applyUpdateHunk(hunk, cwd, trace);
        default: {
            const exhaustiveCheck: never = hunk;
            void exhaustiveCheck;
            return Promise.reject(new ApplyPatchIoError("Unsupported hunk type"));
        }
    }
}

const AFFECTED_KIND: Readonly<Record<Hunk["type"], keyof AffectedPaths>> = {
    add: "added",
    delete: "deleted",
    update: "modified",
};

async function applyHunksToFiles(hunks: Hunk[], cwd: string, trace?: ApplyPatchTrace): Promise<AffectedPaths> {
    if (hunks.length === 0) {
        traceLine(trace, "apply: no_hunks");
        throw new ApplyPatchIoError("No files were modified.");
    }

    const affected: AffectedPaths = { added: [], modified: [], deleted: [] };
    for (const hunk of hunks) {
        const path = await applyHunk(hunk, cwd, trace);
        affected[AFFECTED_KIND[hunk.type]].push(path);
    }
    return affected;
}

function printSummary(affected: AffectedPaths): string {
    const lines: string[] = ["Success. Updated the following files:"];
    for (const path of affected.added) {
        lines.push(`A ${path}`);
    }
    for (const path of affected.modified) {
        lines.push(`M ${path}`);
    }
    for (const path of affected.deleted) {
        lines.push(`D ${path}`);
    }
    return `${lines.join("\n")}\n`;
}

async function runApplyPatchEngineInternal(
    patch: string,
    cwd: string,
    trace?: ApplyPatchTrace,
): Promise<ApplyPatchRunResult> {
    traceLine(trace, "run: start");
    try {
        const { hunks } = parsePatchText(patch, trace);
        const affected = await applyHunksToFiles(hunks, cwd, trace);
        const stdout = printSummary(affected);
        traceLine(
            trace,
            `run: success added=${affected.added.length} modified=${affected.modified.length} deleted=${affected.deleted.length}`,
        );
        return {
            exitCode: 0,
            stdout,
            stderr: "",
        };
    } catch (error) {
        if (error instanceof ApplyPatchParseError) {
            const message =
                error.kind === "invalid_patch"
                    ? `Invalid patch: ${error.message}`
                    : `Invalid patch hunk on line ${error.lineNumber ?? 0}: ${error.message}`;
            traceLine(trace, `run: error kind=parse message=${message}`);
            return {
                exitCode: 1,
                stdout: "",
                stderr: ensureTrailingNewline(message),
            };
        }
        const message = error instanceof Error ? error.message : String(error);
        traceLine(trace, `run: error kind=other message=${message}`);
        return {
            exitCode: 1,
            stdout: "",
            stderr: ensureTrailingNewline(message),
        };
    }
}

export async function runApplyPatchEngine(patch: string, cwd: string): Promise<ApplyPatchRunResult> {
    return runApplyPatchEngineInternal(patch, cwd);
}

export async function runApplyPatchEngineWithTrace(
    patch: string,
    cwd: string,
    trace: ApplyPatchTrace,
): Promise<ApplyPatchRunResult> {
    return runApplyPatchEngineInternal(patch, cwd, trace);
}
