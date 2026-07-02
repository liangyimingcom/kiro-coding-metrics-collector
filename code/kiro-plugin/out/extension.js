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
exports.shouldCleanupGitPath = shouldCleanupGitPath;
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const checkpoint_1 = require("./checkpoint");
const commitWatcher_1 = require("./commitWatcher");
const gitUtils_1 = require("./gitUtils");
const sessionLogWatcher_1 = require("./sessionLogWatcher");
const statusBar_1 = require("./statusBar");
const userSync_1 = require("./userSync");
/**
 * Determine whether a git.path value should be cleaned up.
 * Returns true if gitPath points inside the extension's bin/ directory.
 * Pure function — no side effects — exported for property testing.
 */
function shouldCleanupGitPath(extensionPath, gitPath) {
    const binDir = path.normalize(path.join(extensionPath, "bin"));
    const normalizedGitPath = path.normalize(gitPath);
    return normalizedGitPath.startsWith(binDir + path.sep) || normalizedGitPath === binDir;
}
/**
 * Clean up stale git.path configuration left by previous versions of the extension.
 * Only resets git.path if it points to a path within this extension's bin/ directory.
 */
function cleanupGitPathOverride(extensionPath) {
    try {
        const gitConfig = vscode.workspace.getConfiguration("git");
        const currentGitPath = gitConfig.get("path");
        if (!currentGitPath) {
            return;
        }
        if (shouldCleanupGitPath(extensionPath, currentGitPath)) {
            gitConfig.update("path", undefined, vscode.ConfigurationTarget.Global).then(() => console.log(`[git-ai-kiro] Cleaned up stale git.path: ${currentGitPath}`), (err) => console.error(`[git-ai-kiro] Failed to reset git.path: ${err}`));
        }
    }
    catch (err) {
        console.error(`[git-ai-kiro] Error during git.path cleanup: ${err}`);
    }
}
function activate(context) {
    console.log("[git-ai-kiro] Activating extension");
    console.log(`[git-ai-kiro] Extension path: ${context.extensionPath}`);
    console.log(`[git-ai-kiro] Extension mode: ${context.extensionMode}`);
    console.log(`[git-ai-kiro] Platform: ${process.platform} / ${process.arch}`);
    const statusBar = new statusBar_1.StatusBar();
    // 上报用户登录信息（异步，不阻塞启动）
    (0, userSync_1.reportUserLogin)();
    (0, checkpoint_1.initBundledBinary)(context.extensionPath);
    cleanupGitPathOverride(context.extensionPath);
    if (!(0, checkpoint_1.isBinaryReady)()) {
        statusBar.setState("inactive");
        return;
    }
    statusBar.setState("watching");
    // Install git post-commit hooks for all discovered repos
    (0, gitUtils_1.installHooksForWorkspace)();
    // Get current workspace path — keep as-is for file path resolution.
    // findGitRoot is used internally by sessionLogWatcher for repo discovery,
    // but workspacePath must remain the actual opened directory.
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspacePath) {
        // Create SessionLogWatcher (replaces AIEditManager)
        // Monitors Kiro Execution Log directory changes in real-time,
        // writes AI edit data into git-ai working logs on detection.
        const watcher = new sessionLogWatcher_1.SessionLogWatcher(workspacePath);
        watcher.setStatusBar(statusBar);
        watcher.start(); // async start, don't block activate
        context.subscriptions.push(watcher);
    }
    // CommitWatcher remains unchanged: detect commit → runPostCommit → uploadCommitStats
    const commitWatcher = new commitWatcher_1.CommitWatcher();
    commitWatcher.start();
    context.subscriptions.push(statusBar, commitWatcher);
}
function deactivate() {
    (0, userSync_1.stopUserSync)();
    console.log("[git-ai-kiro] Extension deactivated");
}
//# sourceMappingURL=extension.js.map