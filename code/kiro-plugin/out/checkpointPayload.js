"use strict";
/**
 * CheckpointPayloadBuilder — builds AICheckpointPayload from WriteAction lists.
 *
 * Converts extracted WriteAction records into the payload format expected by
 * `callCheckpointAgentV1` (git-ai checkpoint agent-v1).
 *
 * dirty_files strategy:
 * - Format A (has originalContent): use originalContent as dirty_files value
 * - Format B (no originalContent): read current file content from disk as fallback
 * - When multiple WriteActions modify the same file, use the one with the latest
 *   emittedAt timestamp for modifiedContent
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCheckpointPayload = buildCheckpointPayload;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const checkpoint_1 = require("./checkpoint");
/**
 * Build an AICheckpointPayload from a list of WriteAction records.
 *
 * @param workspacePath - Absolute path to the workspace root
 * @param actions - List of WriteAction records extracted from Execution Logs
 * @param chatSessionId - Optional chat session ID for conversation tracking
 * @param ignorePatterns - Optional list of ignore patterns to filter file paths
 * @returns AICheckpointPayload ready for callCheckpointAgentV1
 */
async function buildCheckpointPayload(workspacePath, actions, chatSessionId, ignorePatterns) {
    const patterns = ignorePatterns ?? [];
    // Filter out actions whose file paths match ignore patterns
    const filteredActions = patterns.length > 0
        ? actions.filter((a) => !(0, checkpoint_1.matchesIgnorePattern)(a.filePath, patterns))
        : actions;
    // Deduplicate file paths for edited_filepaths
    const editedFilePathsSet = new Set();
    for (const action of filteredActions) {
        editedFilePathsSet.add(action.filePath);
    }
    const editedFilepaths = [...editedFilePathsSet];
    // Build dirty_files: for each unique file, pick the action with the latest
    // emittedAt timestamp to get the most recent modifiedContent.
    // Use originalContent (Format A) as the dirty_files value, or fall back to
    // reading the current file from disk (Format B).
    const dirtyFiles = {};
    // Group actions by filePath, keeping the one with the latest emittedAt
    const latestByFile = new Map();
    for (const action of filteredActions) {
        const existing = latestByFile.get(action.filePath);
        if (!existing) {
            latestByFile.set(action.filePath, action);
        }
        else {
            // Use the action with the latest emittedAt timestamp
            const existingTime = existing.emittedAt ?? 0;
            const currentTime = action.emittedAt ?? 0;
            if (currentTime >= existingTime) {
                latestByFile.set(action.filePath, action);
            }
        }
    }
    // Build dirty_files from the latest action per file
    for (const [filePath, action] of latestByFile) {
        if (action.originalContent !== undefined) {
            // Format A: use originalContent as the pre-edit baseline
            dirtyFiles[filePath] = action.originalContent;
        }
        else {
            // Format B fallback: read current file content from disk
            try {
                const absolutePath = path.resolve(workspacePath, filePath);
                const content = await fs.promises.readFile(absolutePath, "utf-8");
                dirtyFiles[filePath] = content;
            }
            catch {
                // If file cannot be read (deleted, permissions, etc.), skip it
                // Silent degradation per error handling strategy
                console.log(`[git-ai-kiro] Could not read file for dirty_files: ${filePath}`);
            }
        }
    }
    return {
        type: "ai_agent",
        repo_working_dir: workspacePath,
        agent_name: "kiro",
        model: "kiro-ai",
        conversation_id: chatSessionId,
        edited_filepaths: editedFilepaths,
        dirty_files: dirtyFiles,
        transcript: {
            messages: [{ type: "assistant", text: "Kiro AI edit" }],
        },
    };
}
//# sourceMappingURL=checkpointPayload.js.map