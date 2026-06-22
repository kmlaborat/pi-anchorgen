/**
 * pi-anchorgen: Generate-and-apply editing for pi coding agent.
 *
 * Registers the anchorgen_edit tool which combines an AI-powered
 * FastApply-style generator with hash-verified file writing via AnchorEdit.
 *
 * Flow:
 *   source + instruction
 *     ↓ FastApplyGenerator
 *   result
 *     ↓ anchoredit apply
 *   File updated
 */

import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { resolve, isAbsolute as pathIsAbsolute } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FastApplyGenerator } from "../../src/generators/fastApply";

// ============================================================================
// Path Resolution (Windows / cygpath support)
// ============================================================================

/**
 * Resolve the anchoredit binary path.
 */
function getAnchorEditBin(): string {
  return process.env.ANCHOREDIT_BIN ?? "anchoredit";
}

/**
 * Normalize a file path for the native anchoredit binary.
 *
 * On Windows, paths like "/tmp/file.rs" (Git Bash / Cygwin / MSYS2 mount style)
 * are not understood by native Windows binaries. Node.js treats "/tmp/..."
 * as "C:\\tmp\\..." which is a different location from the bash-mount temp dir.
 *
 * Strategy:
 * 1. If it looks like a Windows absolute path (C:\\...), pass through.
 * 2. If it starts with "/", try `cygpath -w` to translate the mount prefix
 *    (e.g. /tmp → C:\Users\...\AppData\Local\Temp).
 * 3. Otherwise treat it as a relative path and resolve against cwd.
 * 4. In all cases verify with existsSync; fall back to the original path
 *    so anchoredit can surface its own error message.
 */
function resolveFilePath(filePath: string, cwd: string): string {
  // Windows absolute path (e.g. C:\foo\bar.rs) — pass through
  if (pathIsAbsolute(filePath) && /^[a-zA-Z]:\\/.test(filePath)) {
    return filePath;
  }

  let resolved: string;

  // Looks like a Unix-style absolute path (/tmp/..., /home/..., etc.)
  if (filePath.startsWith("/")) {
    try {
      // Use cygpath -w to translate mount-aware paths to Windows native format.
      // Available in Git Bash, MSYS2, Cygwin environments on Windows.
      const shellPath: string = process.env.ComSpec ?? "/bin/sh";
      resolved = execSync(
        "cygpath -w '" + filePath.replace(/'/g, "'\"'\"'") + "'",
        { shell: shellPath },
      )
        .toString()
        .trim();
    } catch {
      // cygpath not available — fall through to relative resolution
      resolved = resolve(cwd, filePath);
    }
  } else {
    // Relative path — resolve against cwd
    resolved = resolve(cwd, filePath);
  }

  // Verify the file exists at the resolved location
  if (existsSync(resolved)) {
    return resolved;
  }

  // Fall back to the original path so anchoredit can report its own error
  return filePath;
}

// ============================================================================
// Extension Definition
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Register the anchorgen_edit tool
  pi.registerTool({
    name: "anchorgen_edit",
    label: "AnchorGen Edit",
    description:
      "Generate a replacement for a piece of code or text based on an instruction, then apply it to a file with hash verification. Combines generation and application in one step.",
    promptSnippet:
      "Generate and apply an edit based on a natural language instruction",
    promptGuidelines: [
      "Use anchorgen_edit when you want to describe a change in natural language and let the tool generate the replacement.",
      "source must be the exact current content you want to transform (read it first).",
      "anchor must be an exact byte sequence that appears exactly once in the file — typically the same as source.",
      "instruction is a natural language description of the desired change.",
    ],
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file to edit" },
        anchor: {
          type: "string",
          description: "Exact text to match in the file (must be unique)",
        },
        source: {
          type: "string",
          description: "Current content to transform (usually same as anchor)",
        },
        instruction: {
          type: "string",
          description: "Natural language description of the desired change",
        },
      },
      required: ["file", "anchor", "source", "instruction"],
    },

    async execute(_toolCallId, params: { file: string; anchor: string; source: string; instruction: string }, signal, _onUpdate, ctx) {
      const generator = new FastApplyGenerator();

      // Generate the replacement
      const output = await generator.generate({
        source: params.source,
        task: { type: "edit", instruction: params.instruction },
      });

      const filePath = resolveFilePath(params.file, ctx.cwd);
      const anchoreditBin = getAnchorEditBin();

      return withFileMutationQueue(filePath, async () => {
        const result = await pi.exec(
          anchoreditBin,
          ["apply", "--file", filePath, "--anchor", params.anchor, "--replacement", output.result],
          { signal },
        );

        if (result.code !== 0) {
          const output = result.stderr || result.stdout || "";
          if (output.includes("NO_MATCH")) {
            throw new Error(`anchoredit_apply: NO_MATCH — the anchor was not found in the file`);
          }
          if (output.includes("MULTIPLE_MATCHES")) {
            throw new Error(
              `anchoredit_apply: MULTIPLE_MATCHES — the anchor matched more than once. Use a more specific anchor.`,
            );
          }
          throw new Error(`anchoredit_apply failed (exit ${result.code}): ${output.trim()}`);
        }

        return {
          content: [{ type: "text", text: result.stdout.trim() }],
        };
      });
    },
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("pi-anchorgen: anchorgen_edit tool loaded", "info");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Cleanup if needed
  });
}
