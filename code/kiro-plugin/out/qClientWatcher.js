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
exports.QClientLogWatcher = void 0;
/**
 * QClientLogWatcher — 监控 Kiro 的 q-client.log 文件。
 *
 * 当检测到 CodeWhispererRuntimeClient 执行 GetUsageLimitsCommand 时触发回调。
 * 同时从日志中解析 userInfo.userId（格式 "d-<storeId>.<userId>"），
 * 让 userSync 在无法通过 kiro-cli 获取 email 时用该 userId 请求 dashboard 解析。
 *
 * 跨平台日志路径：
 *   macOS:  ~/Library/Application Support/Kiro/logs/<session>/window<N>/exthost/kiro.kiroAgent/q-client.log
 *   Linux:  ~/.config/Kiro/logs/<session>/window<N>/exthost/kiro.kiroAgent/q-client.log
 *   Windows: %APPDATA%/Kiro/logs/<session>/window<N>/exthost/kiro.kiroAgent/q-client.log
 */
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
/** 每隔多久扫描一次日志目录，发现新出现的 q-client.log 文件 */
const DIR_SCAN_INTERVAL_MS = 30 * 1000;
/** fs.watchFile 的轮询间隔 */
const FILE_POLL_INTERVAL_MS = 2000;
/** 识别 GetUsageLimits 调用的标记字符串 */
const TRIGGER_MARKER = '"commandName":"GetUsageLimitsCommand"';
class QClientLogWatcher {
    onTrigger;
    watched = new Map(); // filePath -> last read offset
    /** 从最近一次日志解析到的 userId，供下次触发时作为"最新值"使用 */
    latestUserId = "";
    dirTimer = null;
    stopped = false;
    constructor(onTrigger) {
        this.onTrigger = onTrigger;
    }
    /** 返回目前已解析到的最新 userId，可能为空字符串 */
    getLatestUserId() {
        return this.latestUserId;
    }
    start() {
        this.scanAndWatch();
        this.dirTimer = setInterval(() => this.scanAndWatch(), DIR_SCAN_INTERVAL_MS);
        console.log("[git-ai-kiro] QClientLogWatcher started");
    }
    stop() {
        this.stopped = true;
        if (this.dirTimer) {
            clearInterval(this.dirTimer);
            this.dirTimer = null;
        }
        for (const fp of this.watched.keys()) {
            try {
                fs.unwatchFile(fp);
            }
            catch { /* ignore */ }
        }
        this.watched.clear();
    }
    /** 扫描日志根目录，发现新出现的 q-client.log 文件并开始监控 */
    scanAndWatch() {
        if (this.stopped)
            return;
        const logRoot = getKiroLogRoot();
        if (!fs.existsSync(logRoot))
            return;
        let sessions = [];
        try {
            sessions = fs.readdirSync(logRoot).filter((s) => /^\d{8}T\d{6}$/.test(s));
        }
        catch {
            return;
        }
        for (const session of sessions) {
            const sessionPath = path.join(logRoot, session);
            let windows = [];
            try {
                windows = fs.readdirSync(sessionPath).filter((w) => /^window\d+$/.test(w));
            }
            catch {
                continue;
            }
            for (const win of windows) {
                const qlog = path.join(sessionPath, win, "exthost", "kiro.kiroAgent", "q-client.log");
                if (!this.watched.has(qlog) && fs.existsSync(qlog)) {
                    this.attachWatcher(qlog);
                }
            }
        }
    }
    /** 对单个 q-client.log 文件开始增量监控 */
    attachWatcher(filePath) {
        let startOffset = 0;
        try {
            startOffset = fs.statSync(filePath).size;
        }
        catch { /* ignore */ }
        this.watched.set(filePath, startOffset);
        // 首次附加时读取已有内容中的最新 userId（插件启动后首次事件能立刻用到）
        this.seedLatestUserIdFromFile(filePath, startOffset);
        console.log(`[git-ai-kiro] QClientLogWatcher: watching ${filePath} from offset ${startOffset}`);
        fs.watchFile(filePath, { interval: FILE_POLL_INTERVAL_MS }, (curr, prev) => {
            if (this.stopped)
                return;
            if (curr.size === prev.size)
                return;
            if (curr.size < prev.size) {
                this.watched.set(filePath, 0);
            }
            this.readNewLines(filePath);
        });
    }
    /** 从已有文件内容中提取最新 userId（初始化时调用一次） */
    seedLatestUserIdFromFile(filePath, size) {
        try {
            if (size === 0)
                return;
            // 读取最后 64KB 足以拿到最近的 userId
            const readSize = Math.min(size, 64 * 1024);
            const offset = size - readSize;
            const fd = fs.openSync(filePath, "r");
            try {
                const buf = Buffer.alloc(readSize);
                fs.readSync(fd, buf, 0, readSize, offset);
                const uid = extractLatestUserId(buf.toString("utf-8"));
                if (uid)
                    this.latestUserId = uid;
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch { /* ignore */ }
    }
    /** 读取文件中上次偏移以后的新增内容，检测 trigger 并回调 */
    readNewLines(filePath) {
        const lastOffset = this.watched.get(filePath) ?? 0;
        let stat;
        try {
            stat = fs.statSync(filePath);
        }
        catch {
            return;
        }
        if (stat.size <= lastOffset)
            return;
        let chunk = "";
        try {
            const fd = fs.openSync(filePath, "r");
            try {
                const length = stat.size - lastOffset;
                const buf = Buffer.alloc(length);
                fs.readSync(fd, buf, 0, length, lastOffset);
                chunk = buf.toString("utf-8");
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch (err) {
            console.warn(`[git-ai-kiro] QClientLogWatcher: read failed for ${filePath}: ${err}`);
            return;
        }
        this.watched.set(filePath, stat.size);
        // 持续更新最新 userId
        const uid = extractLatestUserId(chunk);
        if (uid)
            this.latestUserId = uid;
        if (chunk.includes(TRIGGER_MARKER)) {
            console.log(`[git-ai-kiro] QClientLogWatcher: detected GetUsageLimitsCommand, userId=${this.latestUserId || "(unknown)"}`);
            const info = { userId: this.latestUserId };
            Promise.resolve()
                .then(() => this.onTrigger(info))
                .catch((err) => console.warn(`[git-ai-kiro] QClientLogWatcher: onTrigger failed: ${err}`));
        }
    }
}
exports.QClientLogWatcher = QClientLogWatcher;
/** 从日志片段中提取最后出现的 userInfo.userId。找不到返回空串 */
function extractLatestUserId(chunk) {
    // 匹配 Kiro q-client 日志里 "userInfo":{"userId":"d-<storeId>.<uuid>"...} 结构
    const re = /"userInfo"\s*:\s*\{\s*"userId"\s*:\s*"([^"]+)"/g;
    let last = "";
    let m;
    while ((m = re.exec(chunk)) !== null) {
        last = m[1];
    }
    return last;
}
/** 跨平台返回 Kiro 日志根目录 */
function getKiroLogRoot() {
    const platform = os.platform();
    if (platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Kiro", "logs");
    }
    if (platform === "win32") {
        const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        return path.join(appData, "Kiro", "logs");
    }
    return path.join(os.homedir(), ".config", "Kiro", "logs");
}
//# sourceMappingURL=qClientWatcher.js.map