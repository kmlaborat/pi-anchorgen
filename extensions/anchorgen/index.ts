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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FastApplyGenerator } from "../../src/generators/fastApply";

// ============================================================================
// Path Resolution (Windows / cygpath support)
// ============================================================================

/**
 * Resolve a file path relative to the working directory.
 * Handles both absolute and relative paths.
 */
function resolveFilePath(fileParam: string, cwd: string): string {
  if (path.isAbsolute(fileParam)) {
    return fileParam;
  }
  return path.resolve(cwd, fileParam);
}

/**
 * On Windows, convert a native Windows path to a format usable by
 * the anchoredit binary. If cygpath is available, use it to convert
 * to a POSIX-style path (for WSL/Git Bash built binaries).
 *
 * This handles the case where anchoredit was built in a WSL or MSYS2
 * environment and expects POSIX paths.
 */
function toNativePath(filePath: string): string {
  if (process.platform !== "win32") {
    return filePath;
  }

  // Try cygpath first (works for Git Bash, MSYS2, Cygwin)
  const cygResult = spawnSync("cygpath", ["-u", filePath], {
    encoding: "utf-8",
    shell: false,
  });
  if (cygResult.status === 0 && cygResult.stdout.trim()) {
    return cygResult.stdout.trim();
  }

  // Fallback: use Windows path as-is (works for native Windows builds)
  return filePath;
}

// ============================================================================
// AnchorEdit Binary Resolution
// ============================================================================

const KNOWN_BIN_NAMES = ["anchoredit.exe", "anchoredit"];

/**
 * Locate the anchoredit binary.
 *
 * Search order:
 * 1. ANCHOREDIT_BIN env var (explicit override)
 * 2. PATH lookup (spawnSync("anchoredit", ...) would work)
 * 3. Known build output locations relative to workspace
 */
function getAnchorEditBin(): string {
  // 1. Explicit env var
  const envBin = process.env.ANCHOREDIT_BIN;
  if (envBin) {
    if (fs.existsSync(envBin)) {
      return envBin;
    }
    // If env var is a directory, look inside
    if (fs.existsSync(envBin) && fs.statSync(envBin).isDirectory()) {
      for (const name of KNOWN_BIN_NAMES) {
        const candidate = path.join(envBin, name);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    throw new Error(`ANCHOREDIT_BIN points to non-existent path: ${envBin}`);
  }

  // 2. Check PATH by trying to spawn
  for (const name of KNOWN_BIN_NAMES) {
    const result = spawnSync("where", [name], {
      encoding: "utf-8",
      shell: false,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim().split("\n")[0];
    }
  }

  // 3. Search known locations relative to workspace
  const searchDirs = [
    // AnchorEdit target/release (same workspace)
    path.join(__dirname, "..", "..", "..", "AnchorEdit", "target", "release"),
    path.join(__dirname, "..", "..", "..", "AnchorEdit", "target", "debug"),
    // Common workspace patterns
    path.join(process.cwd(), "..", "AnchorEdit", "target", "release"),
    path.join(process.cwd(), "..", "AnchorEdit", "target", "debug"),
  ];

  for (const dir of searchDirs) {
    for (const name of KNOWN_BIN_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "anchoredit binary not found. Set ANCHOREDIT_BIN env var or ensure anchoredit is in PATH. " +
    "See https://github.com/kmlaborat/AnchorEdit for installation.",
  );
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
        const posixPath = toNativePath(filePath);

        // anchoredit accepts both POSIX and Windows paths for --file argument.
        // Node.js spawnSync requires Windows native paths for the binary on Windows.
        // anchoreditBin is kept as Windows path, posixPath is used for the --file argument.
        const result = spawnSync(anchoreditBin, [
          "apply",
          "--file",
          posixPath,
          "--anchor",
          params.anchor,
          "--replacement",
          output.result,
        ], {
          encoding: "utf-8",
          shell: false,
          signal,
          timeout: 30000,
        });

        if (result.status !== 0) {
          const errMsg = result.stderr || result.stdout || "anchoredit apply failed";
          throw new Error(errMsg.trim());
        }

        return {
          content: [{ type: "text", text: (result.stdout || "").trim() }],
          details: {},
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
