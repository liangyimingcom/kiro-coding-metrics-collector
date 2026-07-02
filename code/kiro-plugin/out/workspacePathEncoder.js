"use strict";
/**
 * WorkspacePathEncoder — pure-function module for workspace path encoding
 * and shared type definitions used across the Kiro Session Monitor modules.
 *
 * Uses Node.js built-in URL-safe Base64 encoding (base64url) which replaces
 * `+` with `-`, `/` with `_`, and omits trailing `=` padding. This matches
 * the encoding Kiro IDE uses for workspace-sessions directory names.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeWorkspacePath = encodeWorkspacePath;
exports.decodeWorkspacePath = decodeWorkspacePath;
// ── Encoding Functions ───────────────────────────────────────────────
/**
 * Encode a workspace absolute path to a URL-safe Base64 string.
 *
 * Uses Node.js built-in `base64url` encoding:
 * - `-` replaces `+`
 * - `_` replaces `/`
 * - No trailing `=` padding
 *
 * Path characters (backslashes on Windows, forward slashes on Unix)
 * are preserved as-is in the encoded representation.
 */
function encodeWorkspacePath(workspacePath) {
    return Buffer.from(workspacePath).toString("base64url");
}
/**
 * Decode a URL-safe Base64 string back to the original workspace absolute path.
 */
function decodeWorkspacePath(encoded) {
    return Buffer.from(encoded, "base64url").toString();
}
//# sourceMappingURL=workspacePathEncoder.js.map