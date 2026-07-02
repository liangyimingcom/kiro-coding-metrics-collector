"use strict";
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
exports.initBundledBinary = initBundledBinary;
exports.getGitAiBinary = getGitAiBinary;
exports.isBinaryReady = isBinaryReady;
exports.getIgnorePatterns = getIgnorePatterns;
exports.matchesIgnorePattern = matchesIgnorePattern;
exports.callCheckpointAgentV1 = callCheckpointAgentV1;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
let bundledBinaryPath = null;
let binaryReady = false;
function initBundledBinary(extensionPath) {
    const platform = os.platform();
    let binaryName;
    if (platform === "win32") {
        binaryName = "git-ai.exe";
    }
    else if (platform === "linux") {
        binaryName = "git-ai-linux";
    }
    else {
        binaryName = "git-ai";
    }
    const binPath = path.join(extensionPath, "bin", binaryName);
    console.log(`[git-ai-kiro] Looking for bundled binary at: ${binPath}`);
    if (!fs.existsSync(binPath)) {
        console.error(`[git-ai-kiro] Bundled binary NOT FOUND at ${binPath}`);
        vscode.window.showErrorMessage(`[git-ai-kiro] Bundled binary not found at ${binPath}. ` +
            "The extension package may be corrupted — please reinstall.");
        return;
    }
    // macOS: remove quarantine attribute
    if (platform === "darwin") {
        try {
            (0, node_child_process_1.execFileSync)("xattr", ["-cr", binPath], { timeout: 5000 });
            console.log(`[git-ai-kiro] Removed quarantine attribute from ${binPath}`);
        }
        catch {
            console.log(`[git-ai-kiro] xattr -cr skipped (no quarantine or xattr unavailable)`);
        }
    }
    // Ensure +x on Unix
    if (platform !== "win32") {
        try {
            fs.chmodSync(binPath, 0o755);
        }
        catch {
            // best-effort
        }
    }
    bundledBinaryPath = binPath;
    binaryReady = true;
    console.log(`[git-ai-kiro] Bundled binary ready: ${binPath}`);
}
function getGitAiBinary() {
    return bundledBinaryPath;
}
function isBinaryReady() {
    return binaryReady;
}
/**
 * Read ignore patterns from the extension configuration.
 */
function getIgnorePatterns() {
    const config = vscode.workspace.getConfiguration("gitai.kiro");
    return config.get("ignorePatterns") ?? [];
}
/**
 * Check if a file path matches any of the ignore patterns.
 * Supports directory names (e.g. "node_modules") and glob-like patterns (e.g. "*.lock").
 */
function matchesIgnorePattern(filePath, patterns) {
    const normalized = filePath.replace(/\\/g, "/");
    const segments = normalized.split("/");
    for (const pattern of patterns) {
        // Glob pattern with *
        if (pattern.includes("*")) {
            const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
            // Match against the full path or just the filename
            const filename = segments[segments.length - 1];
            if (regex.test(filename) || regex.test(normalized)) {
                return true;
            }
        }
        else {
            // Directory or exact filename match
            if (segments.includes(pattern) || normalized.endsWith("/" + pattern) || normalized === pattern) {
                return true;
            }
        }
    }
    return false;
}
function callCheckpointAgentV1(cwd, payload) {
    return new Promise((resolve) => {
        console.log(`[git-ai-kiro] Spawning: ${bundledBinaryPath} checkpoint agent-v1 --hook-input stdin (cwd: ${cwd})`);
        // Windows 上 git-ai 用 cwd（反斜杠）拼接 edited_filepaths（正斜杠）会产生混合路径，
        // 导致 "Failed to find any git repositories" 错误。统一转为反斜杠。
        let finalPayload = payload;
        if (process.platform === "win32") {
            const p = { ...finalPayload };
            if (Array.isArray(p.edited_filepaths)) {
                p.edited_filepaths = p.edited_filepaths.map((fp) => fp.replace(/\//g, "\\"));
            }
            if (p.dirty_files && typeof p.dirty_files === "object") {
                const newDirty = {};
                for (const [k, v] of Object.entries(p.dirty_files)) {
                    newDirty[k.replace(/\//g, "\\")] = v;
                }
                p.dirty_files = newDirty;
            }
            if (Array.isArray(p.will_edit_filepaths)) {
                p.will_edit_filepaths = p.will_edit_filepaths.map((fp) => fp.replace(/\//g, "\\"));
            }
            finalPayload = p;
        }
        const proc = (0, node_child_process_1.spawn)(bundledBinaryPath, ["checkpoint", "agent-v1", "--hook-input", "stdin"], {
            cwd,
            env: {
                ...process.env,
                // Disable daemon mode — run checkpoint synchronously so we get
                // immediate feedback and the working log is written before commit.
                GIT_AI_ASYNC_MODE: "false",
            },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        proc.on("error", (error) => {
            console.error(`[git-ai-kiro] Spawn error: ${error.message}`);
            resolve(false);
        });
        proc.on("close", (code) => {
            if (stdout.trim()) {
                console.log(`[git-ai-kiro] git-ai stdout: ${stdout.trim()}`);
            }
            if (stderr.trim()) {
                console.log(`[git-ai-kiro] git-ai stderr: ${stderr.trim()}`);
            }
            if (code !== 0) {
                console.error(`[git-ai-kiro] git-ai exited with code ${code}`);
                resolve(false);
            }
            else {
                console.log(`[git-ai-kiro] git-ai exited with code 0`);
                resolve(true);
            }
        });
        const payloadStr = JSON.stringify(finalPayload);
        console.log(`[git-ai-kiro] Payload size: ${payloadStr.length} bytes`);
        proc.stdin.write(payloadStr);
        proc.stdin.end();
    });
}
//# sourceMappingURL=checkpoint.js.map