"use strict";
/**
 * SessionLogScanner — coordinator module for discovering, reading, and filtering
 * Kiro Execution Log files from the Kiro Agent Dir.
 *
 * Responsibilities:
 * - Cross-platform resolution of the Kiro Agent Dir path
 * - Enumerating and reading execution log JSON files
 * - Filtering by session ID and time window (pure functions)
 * - Applying ignore patterns to exclude unwanted file paths
 * - Graceful error handling: all errors are caught and logged, never thrown
 *
 * Pure filter functions (`filterBySessionId`, `filterByTimeWindow`) are exported
 * separately from the class for easy property-based testing.
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
exports.SessionLogScanner = exports.MAX_FILE_SIZE = void 0;
exports.filterBySessionId = filterBySessionId;
exports.filterByTimeWindow = filterByTimeWindow;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const workspacePathEncoder_1 = require("./workspacePathEncoder");
const sessionLogParser_1 = require("./sessionLogParser");
const checkpoint_1 = require("./checkpoint");
// ── Constants ────────────────────────────────────────────────────────
/** Maximum file size (5 MB) — files larger than this are skipped with a warning. */
exports.MAX_FILE_SIZE = 5 * 1024 * 1024;
// ── Pure Filter Functions ────────────────────────────────────────────
/**
 * Filter ParseResult entries by session ID.
 *
 * Returns only those results whose `chatSessionId` is present in the
 * given `sessionIds` set. Results without a `chatSessionId` are excluded.
 */
function filterBySessionId(logs, sessionIds) {
    return logs.filter((log) => log.chatSessionId !== undefined && sessionIds.has(log.chatSessionId));
}
/**
 * Filter ParseResult entries by time window.
 *
 * Returns only those results whose `endTime` falls within the window
 * `[beforeTimestamp - windowMs, beforeTimestamp]`. Results without an
 * `endTime` are excluded.
 */
function filterByTimeWindow(logs, beforeTimestamp, windowMs) {
    const windowStart = beforeTimestamp - windowMs;
    return logs.filter((log) => log.endTime !== undefined &&
        log.endTime >= windowStart &&
        log.endTime <= beforeTimestamp);
}
// ── SessionLogScanner Class ──────────────────────────────────────────
/**
 * Coordinator that discovers, reads, and filters Execution Log files
 * from the Kiro Agent Dir on disk.
 */
class SessionLogScanner {
    agentDir;
    constructor(agentDir) {
        this.agentDir = agentDir ?? SessionLogScanner.resolveAgentDir();
    }
    /**
     * Resolve the Kiro Agent Dir path for the current platform.
     *
     * Accepts optional overrides for testability:
     * - `platform`: defaults to `os.platform()`
     * - `homeDir`: defaults to `os.homedir()`
     * - `appData`: defaults to `process.env.APPDATA` (Windows only)
     *
     * Platform paths:
     * - macOS:   ~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/
     * - Windows: %APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\
     * - Linux:   ~/.config/Kiro/User/globalStorage/kiro.kiroagent/
     */
    static resolveAgentDir(platform, homeDir, appData) {
        const plat = platform ?? os.platform();
        const home = homeDir ?? os.homedir();
        switch (plat) {
            case "darwin":
                return path.join(home, "Library", "Application Support", "Kiro", "User", "globalStorage", "kiro.kiroagent");
            case "win32": {
                const base = appData ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
                return path.join(base, "Kiro", "User", "globalStorage", "kiro.kiroagent");
            }
            default:
                // Linux and other Unix-like platforms
                return path.join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
        }
    }
    /**
     * Parse a single execution log file and return a ParseResult.
     *
     * Returns `null` if the file cannot be read, is too large, or fails to parse.
     * All errors are caught and logged — never thrown.
     */
    async parseExecutionLogFile(filePath) {
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size > exports.MAX_FILE_SIZE) {
                console.warn(`[git-ai-kiro] Skipping oversized execution log (${stat.size} bytes): ${filePath}`);
                return null;
            }
            const content = await fs.promises.readFile(filePath, "utf-8");
            const result = (0, sessionLogParser_1.parseExecutionLog)(content);
            return result;
        }
        catch (error) {
            console.warn(`[git-ai-kiro] Failed to read/parse execution log: ${filePath}`, error);
            return null;
        }
    }
    /**
     * Get the set of session IDs associated with a workspace.
     *
     * Reads `workspace-sessions/<base64-encoded-path>/sessions.json` from
     * the Agent Dir and extracts session IDs.
     *
     * Returns an empty set if the file doesn't exist or can't be parsed.
     */
    async getWorkspaceSessionIds(workspacePath) {
        try {
            const encoded = (0, workspacePathEncoder_1.encodeWorkspacePath)(workspacePath);
            const sessionsFile = path.join(this.agentDir, "workspace-sessions", encoded, "sessions.json");
            const content = await fs.promises.readFile(sessionsFile, "utf-8");
            const ids = (0, sessionLogParser_1.parseSessionsJson)(content);
            return new Set(ids);
        }
        catch (error) {
            console.warn(`[git-ai-kiro] Failed to read workspace session IDs for: ${workspacePath}`, error);
            return new Set();
        }
    }
    /**
     * Scan the Agent Dir for all AI edits associated with a workspace,
     * filtered by a time window ending at `beforeTimestamp`.
     *
     * Steps:
     * 1. Verify Agent Dir exists
     * 2. Get workspace session IDs
     * 3. Enumerate execution log files under `<workspace-hash>/414d* /` directories
     * 4. Parse each file, filter by session ID and time window
     * 5. Apply ignore patterns to filter out unwanted file paths
     * 6. Return aggregated ScanResult
     *
     * @param workspacePath  Absolute path to the workspace root
     * @param beforeTimestamp  Upper bound of the time window (ms since epoch)
     * @param windowMs  Size of the time window in ms (default: 1 hour)
     * @param ignorePatterns  Optional ignore patterns (defaults to empty)
     */
    async scanForAIEdits(workspacePath, beforeTimestamp, windowMs = 3_600_000, ignorePatterns = []) {
        const emptyResult = {
            writeActions: [],
            scannedFiles: 0,
            skippedFiles: 0,
        };
        // 1. Verify Agent Dir exists
        try {
            await fs.promises.access(this.agentDir);
        }
        catch {
            console.warn(`[git-ai-kiro] Agent Dir does not exist: ${this.agentDir}`);
            return emptyResult;
        }
        // 2. Get workspace session IDs
        const sessionIds = await this.getWorkspaceSessionIds(workspacePath);
        // 3. Enumerate execution log directories
        let topLevelEntries;
        try {
            topLevelEntries = await fs.promises.readdir(this.agentDir);
        }
        catch (error) {
            console.warn(`[git-ai-kiro] Failed to read Agent Dir: ${this.agentDir}`, error);
            return emptyResult;
        }
        const allParseResults = [];
        let scannedFiles = 0;
        let skippedFiles = 0;
        for (const topEntry of topLevelEntries) {
            // Skip non-directory entries and known non-log directories
            if (topEntry === "workspace-sessions")
                continue;
            const topPath = path.join(this.agentDir, topEntry);
            let topStat;
            try {
                topStat = await fs.promises.stat(topPath);
            }
            catch {
                continue;
            }
            if (!topStat.isDirectory())
                continue;
            // Look for 414d* subdirectories (execution log directories)
            let subEntries;
            try {
                subEntries = await fs.promises.readdir(topPath);
            }
            catch {
                continue;
            }
            for (const subEntry of subEntries) {
                if (!subEntry.startsWith("414d"))
                    continue;
                const subPath = path.join(topPath, subEntry);
                let subStat;
                try {
                    subStat = await fs.promises.stat(subPath);
                }
                catch {
                    continue;
                }
                if (!subStat.isDirectory())
                    continue;
                // Enumerate JSON files in this execution log directory
                let logFiles;
                try {
                    logFiles = await fs.promises.readdir(subPath);
                }
                catch {
                    continue;
                }
                for (const logFile of logFiles) {
                    // Kiro execution log files are named by hash without .json extension.
                    // Skip known non-log entries (directories, etc.) by checking stat.
                    const logFilePath = path.join(subPath, logFile);
                    const result = await this.parseExecutionLogFile(logFilePath);
                    if (result === null) {
                        skippedFiles++;
                        continue;
                    }
                    scannedFiles++;
                    allParseResults.push(result);
                }
            }
        }
        // 4. Filter by session ID (if we have session IDs)
        let filtered;
        if (sessionIds.size > 0) {
            filtered = filterBySessionId(allParseResults, sessionIds);
        }
        else {
            // No session IDs available — include all results
            filtered = allParseResults;
        }
        // 5. Filter by time window
        filtered = filterByTimeWindow(filtered, beforeTimestamp, windowMs);
        // 6. Sort by endTime ascending
        filtered.sort((a, b) => {
            const ta = a.endTime ?? 0;
            const tb = b.endTime ?? 0;
            return ta - tb;
        });
        // 7. Aggregate write actions and apply ignore patterns
        const writeActions = [];
        for (const result of filtered) {
            for (const action of result.writeActions) {
                if (ignorePatterns.length > 0 &&
                    (0, checkpoint_1.matchesIgnorePattern)(action.filePath, ignorePatterns)) {
                    console.log(`[git-ai-kiro] Ignoring file path matching ignore pattern: ${action.filePath}`);
                    continue;
                }
                writeActions.push(action);
            }
        }
        return {
            writeActions,
            scannedFiles,
            skippedFiles,
        };
    }
}
exports.SessionLogScanner = SessionLogScanner;
//# sourceMappingURL=sessionLogScanner.js.map