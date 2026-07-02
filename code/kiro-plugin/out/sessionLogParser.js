"use strict";
/**
 * SessionLogParser — pure-function module for parsing Kiro Execution Logs.
 *
 * Supports two log formats:
 * - Format A: `actions` array with full originalContent/modifiedContent (Autopilot/Spec workflows)
 * - Format B: `context.messages` with toolUse entries (Chat workflows)
 *
 * All functions are pure (no I/O, no VS Code API dependencies) and never throw.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WRITE_ACTION_TYPES = exports.FORMAT_B_TOOL_NAMES = void 0;
exports.extractFormatAWriteActions = extractFormatAWriteActions;
exports.extractFormatBWriteActions = extractFormatBWriteActions;
exports.parseExecutionLog = parseExecutionLog;
exports.parseSessionsJson = parseSessionsJson;
exports.serializeWriteActions = serializeWriteActions;
exports.deserializeWriteActions = deserializeWriteActions;
// ── Format B Constants ───────────────────────────────────────────────
/**
 * Set of tool names that represent file-writing operations in Format B logs.
 * Only toolUse entries with these names are extracted from context.messages.
 */
exports.FORMAT_B_TOOL_NAMES = new Set([
    "fsWrite",
    "strReplace",
    "fsAppend",
    "deleteFile",
]);
// ── Constants ────────────────────────────────────────────────────────
/**
 * Set of actionType values that represent file-writing operations.
 * Only actions with these types are extracted from Format A logs.
 */
exports.WRITE_ACTION_TYPES = new Set([
    "replace",
    "create",
    "write",
    "append",
    "editCode",
    "delete",
    "smartRelocate",
]);
// ── Format A Extraction ──────────────────────────────────────────────
/**
 * Extract WriteAction records from a Format A `actions` array.
 *
 * Rules:
 * - Only actions with `actionState === "Accepted"` are included
 * - Only actions with `actionType` in WRITE_ACTION_TYPES are included
 * - `file`, `originalContent`, `modifiedContent` are read from `input`
 * - `create` actions have `originalContent` set to empty string
 * - `delete` actions have `modifiedContent` set to empty string
 * - Results are sorted by `emittedAt` ascending
 */
function extractFormatAWriteActions(actions) {
    const results = [];
    for (const action of actions) {
        if (action == null || typeof action !== "object") {
            continue;
        }
        const a = action;
        // Filter: only Accepted (or Success for delete) actions with a write actionType
        if (a.actionState !== "Accepted" && !(a.actionState === "Success" && a.actionType === "delete")) {
            continue;
        }
        const actionType = a.actionType;
        if (typeof actionType !== "string" || !exports.WRITE_ACTION_TYPES.has(actionType)) {
            continue;
        }
        // Extract fields from input object
        const input = a.input;
        if (input == null || typeof input !== "object") {
            continue;
        }
        const inp = input;
        const file = inp.file;
        if (typeof file !== "string") {
            continue;
        }
        // Determine originalContent and modifiedContent based on actionType
        let originalContent;
        let modifiedContent;
        if (actionType === "create") {
            // create: originalContent is always empty string
            originalContent = "";
            modifiedContent =
                typeof inp.modifiedContent === "string"
                    ? inp.modifiedContent
                    : undefined;
        }
        else if (actionType === "delete") {
            // delete: modifiedContent is always empty string
            originalContent =
                typeof inp.originalContent === "string"
                    ? inp.originalContent
                    : undefined;
            modifiedContent = "";
        }
        else {
            // replace, write, append, editCode, smartRelocate
            originalContent =
                typeof inp.originalContent === "string"
                    ? inp.originalContent
                    : undefined;
            modifiedContent =
                typeof inp.modifiedContent === "string"
                    ? inp.modifiedContent
                    : undefined;
        }
        // Extract emittedAt timestamp
        const emittedAt = typeof a.emittedAt === "number" ? a.emittedAt : undefined;
        results.push({
            actionType,
            filePath: file,
            originalContent,
            modifiedContent,
            emittedAt,
        });
    }
    // Sort by emittedAt ascending (actions without emittedAt go to the end)
    results.sort((a, b) => {
        const ta = a.emittedAt ?? Number.MAX_SAFE_INTEGER;
        const tb = b.emittedAt ?? Number.MAX_SAFE_INTEGER;
        return ta - tb;
    });
    return results;
}
// ── Format B Extraction ──────────────────────────────────────────────
/**
 * Map a Format B tool name to a WriteAction actionType and extract the file path.
 * Returns null if the tool name is not recognized or args are invalid.
 */
function extractFormatBFields(name, args) {
    switch (name) {
        case "fsWrite": {
            const filePath = args.path;
            if (typeof filePath !== "string")
                return null;
            return {
                actionType: "write",
                filePath,
                modifiedContent: typeof args.text === "string" ? args.text : undefined,
            };
        }
        case "strReplace": {
            const filePath = args.path;
            if (typeof filePath !== "string")
                return null;
            return { actionType: "replace", filePath };
        }
        case "fsAppend": {
            const filePath = args.path;
            if (typeof filePath !== "string")
                return null;
            return {
                actionType: "append",
                filePath,
                modifiedContent: typeof args.text === "string" ? args.text : undefined,
            };
        }
        case "deleteFile": {
            const filePath = args.targetFile;
            if (typeof filePath !== "string")
                return null;
            return { actionType: "delete", filePath, modifiedContent: "" };
        }
        default:
            return null;
    }
}
/**
 * Extract WriteAction records from Format B `context.messages` array.
 *
 * Rules:
 * - Scan `role: "bot"` messages for `entries` with `type: "toolUse"`
 *   and `name` in FORMAT_B_TOOL_NAMES
 * - Match each toolUse entry with a corresponding `toolUseResponse`
 *   (via `id` field) — only keep calls where `success === true`
 * - Field mapping:
 *   - fsWrite: args.path → filePath, args.text → modifiedContent
 *   - strReplace: args.path → filePath
 *   - fsAppend: args.path → filePath, args.text → modifiedContent
 *   - deleteFile: args.targetFile → filePath, modifiedContent → ""
 */
function extractFormatBWriteActions(messages) {
    // First pass: collect all toolUseResponse entries keyed by id,
    // so we can check success status when processing toolUse entries.
    const responseMap = new Map();
    for (const msg of messages) {
        if (msg == null || typeof msg !== "object")
            continue;
        const m = msg;
        const entries = m.entries;
        if (!Array.isArray(entries))
            continue;
        for (const entry of entries) {
            if (entry == null || typeof entry !== "object")
                continue;
            const e = entry;
            if (e.type === "toolUseResponse" && typeof e.id === "string") {
                responseMap.set(e.id, e.success === true);
            }
        }
    }
    // Second pass: extract toolUse entries from bot messages
    const results = [];
    for (const msg of messages) {
        if (msg == null || typeof msg !== "object")
            continue;
        const m = msg;
        // Only scan bot messages
        if (m.role !== "bot")
            continue;
        const entries = m.entries;
        if (!Array.isArray(entries))
            continue;
        for (const entry of entries) {
            if (entry == null || typeof entry !== "object")
                continue;
            const e = entry;
            // Must be a toolUse entry with a recognized write tool name
            if (e.type !== "toolUse")
                continue;
            const name = e.name;
            if (typeof name !== "string" || !exports.FORMAT_B_TOOL_NAMES.has(name))
                continue;
            // Must have an id for matching with toolUseResponse
            const id = e.id;
            if (typeof id !== "string")
                continue;
            // Only include if the corresponding toolUseResponse has success === true
            const success = responseMap.get(id);
            if (success !== true)
                continue;
            // Extract args
            const args = e.args;
            if (args == null || typeof args !== "object")
                continue;
            const fields = extractFormatBFields(name, args);
            if (fields == null)
                continue;
            results.push({
                actionType: fields.actionType,
                filePath: fields.filePath,
                modifiedContent: fields.modifiedContent,
            });
        }
    }
    return results;
}
// ── Main Entry Point ─────────────────────────────────────────────────
/**
 * Parse an Execution Log JSON string and extract WriteAction records.
 *
 * Auto-detects the log format:
 * - If JSON contains a non-empty `actions` array → Format A extraction
 * - Otherwise checks `context.messages` → Format B extraction
 * - Any parse error → returns empty result, never throws
 */
function parseExecutionLog(jsonString) {
    const emptyResult = {
        writeActions: [],
        format: "B",
    };
    let parsed;
    try {
        parsed = JSON.parse(jsonString);
    }
    catch {
        return emptyResult;
    }
    if (parsed == null || typeof parsed !== "object") {
        return emptyResult;
    }
    const obj = parsed;
    // Extract common metadata
    const chatSessionId = typeof obj.chatSessionId === "string" ? obj.chatSessionId : undefined;
    const endTime = typeof obj.endTime === "number" ? obj.endTime : undefined;
    // Format detection: non-empty actions array → Format A
    const actions = obj.actions;
    if (Array.isArray(actions) && actions.length > 0) {
        return {
            writeActions: extractFormatAWriteActions(actions),
            format: "A",
            chatSessionId,
            endTime,
        };
    }
    // Fallback: context.messages → Format B
    const context = obj.context;
    if (context != null && typeof context === "object") {
        const ctx = context;
        const messages = ctx.messages;
        if (Array.isArray(messages)) {
            return {
                writeActions: extractFormatBWriteActions(messages),
                format: "B",
                chatSessionId,
                endTime,
            };
        }
    }
    // No recognizable format
    return {
        writeActions: [],
        format: "B",
        chatSessionId,
        endTime,
    };
}
// ── Session ID Parsing ───────────────────────────────────────────────
/**
 * Parse a sessions.json string and extract session ID list.
 *
 * Expected format: array of objects with `sessionId` string field.
 * Returns empty array on any parse error, never throws.
 */
function parseSessionsJson(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const ids = [];
        for (const item of parsed) {
            if (item != null && typeof item === "object") {
                const obj = item;
                if (typeof obj.sessionId === "string") {
                    ids.push(obj.sessionId);
                }
            }
        }
        return ids;
    }
    catch {
        return [];
    }
}
// ── Serialization ────────────────────────────────────────────────────
/**
 * Serialize a WriteAction list to a JSON string.
 * Returns "[]" if serialization fails, never throws.
 */
function serializeWriteActions(actions) {
    try {
        return JSON.stringify(actions);
    }
    catch {
        return "[]";
    }
}
/**
 * Deserialize a JSON string back to a WriteAction list.
 * Returns empty array if deserialization fails, never throws.
 */
function deserializeWriteActions(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const results = [];
        for (const item of parsed) {
            if (item == null || typeof item !== "object")
                continue;
            const obj = item;
            // Require minimum fields: actionType and filePath must be strings
            if (typeof obj.actionType !== "string")
                continue;
            if (typeof obj.filePath !== "string")
                continue;
            const action = {
                actionType: obj.actionType,
                filePath: obj.filePath,
            };
            if (typeof obj.originalContent === "string") {
                action.originalContent = obj.originalContent;
            }
            if (typeof obj.modifiedContent === "string") {
                action.modifiedContent = obj.modifiedContent;
            }
            if (typeof obj.emittedAt === "number") {
                action.emittedAt = obj.emittedAt;
            }
            results.push(action);
        }
        return results;
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=sessionLogParser.js.map