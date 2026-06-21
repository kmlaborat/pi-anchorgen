/**
 * FastApplyGenerator — Generator implementation using FastApply-style models.
 *
 * Ported from pi-fa-merge's fast-apply-merge logic.
 * Calls an OpenAI-compatible endpoint serving a fast-apply model,
 * using the tag-based prompt format (<code>, <update>, <updated-code>).
 */

import * as fs from "fs";
import * as path from "path";
import type { GenerationInput, GenerationOutput, Generator } from "../generator";

// ============================================================================
// .env File Loader
// ============================================================================

function loadEnvFile(): void {
  try {
    const possiblePaths = [
      path.join(process.cwd(), ".env"),
      path.join(__dirname, "..", "..", ".env"),
      path.join(__dirname, "..", ".env"),
    ];

    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        const lines = content.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;

          const eqIndex = trimmed.indexOf("=");
          if (eqIndex === -1) continue;

          const key = trimmed.substring(0, eqIndex).trim();
          let value = trimmed.substring(eqIndex + 1).trim();

          // Remove surrounding quotes if present
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }

          process.env[key] = value;
        }

        return; // Found and loaded .env file
      }
    }
  } catch {
    // Silently fail — environment variables might be set externally
  }
}

// Load environment variables from .env file at module initialization
loadEnvFile();

// ============================================================================
// Types
// ============================================================================

interface EditTask {
  type: "edit";
  instruction: string;
}

interface MergeResult {
  success: boolean;
  updated_code?: string;
  error?: string;
  details?: string;
}

interface StructureValidationResult {
  valid: boolean;
  details?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ENDPOINT_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_MODEL_NAME = "fast-apply-7b";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_CONTEXT_TOKENS = 8192;
const MAX_CODE_LINES = 500;

// ============================================================================
// Prompt Builder
// ============================================================================

function buildPrompt(originalCode: string, instruction: string): string {
  return `You are a code transformation assistant. Your job is to transform the original code according to the instruction.

Original code:
<code>
${originalCode}
</code>

Instruction (the changes to apply):
<update>
${instruction}
</update>

Instructions:
1. Analyze the original code and the instruction
2. Determine what changes are needed
3. Apply the changes to the original code while preserving all other content
4. Maintain proper indentation, comments, and code structure
5. Output ONLY the complete transformed code wrapped in <updated-code> tags

CRITICAL REQUIREMENTS:
- Do NOT omit any part of the original code
- Do NOT use ellipsis (...) or any abbreviation to skip code
- Output MUST include ALL lines from the original code, from line 1 to the last line
- The transformed code must be COMPLETE and SELF-CONTAINED
- Do NOT truncate the beginning or end of the code
- If the original code has 100 lines, your output should have at least 100 lines (plus any additions)

Output format:
<updated-code>
[your complete transformed code here - include EVERY line]
</updated-code>
`;
}

// ============================================================================
// Structure Validation
// ============================================================================

function validateStructure(
  originalCode: string,
  updatedCode: string,
): StructureValidationResult {
  // Extract important elements from original code
  const originalFunctions = originalCode.match(/\b(?:function|def|class)\s+(\w+)/g);
  const originalImports = originalCode.match(/\b(?:import|require)\s+/g);

  // Check function/class preservation
  if (originalFunctions) {
    for (const fn of originalFunctions) {
      const fnName = fn.split(/\s+/).pop();
      if (!fnName || !updatedCode.includes(fnName)) {
        return {
          valid: false,
          details: `Critical error: Original function/class "${fnName}" was lost during merge.`,
        };
      }
    }
  }

  // Check import preservation (imports should generally be preserved)
  if (originalImports && originalImports.length > 0) {
    const updatedImports = updatedCode.match(/\b(?:import|require)\s+/g);
    if (!updatedImports || updatedImports.length === 0) {
      return {
        valid: false,
        details: "Critical error: All imports/require statements were lost during merge.",
      };
    }
  }

  // Check code line count decrease (50%+ decrease is suspicious)
  const originalLines = originalCode.split("\n").filter((l) => l.trim()).length;
  const updatedLines = updatedCode.split("\n").filter((l) => l.trim()).length;

  if (originalLines > 0 && updatedLines < originalLines * 0.5) {
    return {
      valid: false,
      details: `Critical error: Code lost too many lines (${originalLines} -> ${updatedLines}).`,
    };
  }

  // Check prefix preservation (first 20% of original code should be present)
  // Skip for very small files (5 lines or less) to avoid false positives
  const originalLinesList = originalCode.split("\n");

  if (originalLinesList.length > 5) {
    const prefixLength = Math.max(5, Math.floor(originalLinesList.length * 0.2));
    const originalPrefix = originalLinesList.slice(0, prefixLength).join("\n").trim();

    if (originalPrefix && !updatedCode.startsWith(originalPrefix)) {
      return {
        valid: false,
        details: `Critical error: Original code prefix was lost. Expected first ${prefixLength} lines to be preserved but they were not found in the merged code.`,
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// Output Parser
// ============================================================================

function parseOutput(rawResponse: string, originalCode: string): MergeResult {
  const openTag = "<updated-code>";
  const closeTag = "</updated-code>";

  const openIndex = rawResponse.indexOf(openTag);
  if (openIndex === -1) {
    return {
      success: false,
      error: "MALFORMED_OUTPUT",
      details: "Opening tag <updated-code> was not found.",
    };
  }

  const contentStart = openIndex + openTag.length;
  const closeIndex = rawResponse.indexOf(closeTag, contentStart);
  if (closeIndex === -1) {
    return {
      success: false,
      error: "MALFORMED_OUTPUT",
      details: "Closing tag </updated-code> was not found.",
    };
  }

  const extracted = rawResponse.substring(contentStart, closeIndex).trim();

  // Remove markdown code block markers if present
  let code = extracted;
  const codeBlockMatch = code.match(/^```[^\n]*\n?([\s\S]*?)\n?```$/);
  if (codeBlockMatch) {
    code = codeBlockMatch[1].trim();
  }

  // Structure validation
  const validation = validateStructure(originalCode, code);
  if (!validation.valid) {
    return {
      success: false,
      error: "STRUCTURE_MANGLE_ERROR",
      details: validation.details,
    };
  }

  return {
    success: true,
    updated_code: code,
  };
}

// ============================================================================
// OpenAI-Compatible API Client
// ============================================================================

async function callOpenAiCompatibleApi(
  endpointUrl: string,
  apiKey: string,
  modelName: string,
  prompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = `${endpointUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Exponential Backoff Retry
// ============================================================================

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt < MAX_RETRIES && isRetryable(error)) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw lastError;
      }
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("429") ||
      error.message.includes("500") ||
      error.message.includes("502") ||
      error.message.includes("503") ||
      error.message.includes("504")
    );
  }
  return false;
}

// ============================================================================
// FastApplyGenerator
// ============================================================================

export class FastApplyGenerator implements Generator {
  async generate(input: GenerationInput): Promise<GenerationOutput> {
    const endpointUrl =
      process.env.FAST_APPLY_ENDPOINT_URL || DEFAULT_ENDPOINT_URL;
    const modelName =
      process.env.FAST_APPLY_MODEL_NAME || DEFAULT_MODEL_NAME;

    // Validate source
    if (!input.source || !input.source.trim()) {
      throw new Error(
        "VALIDATION_ERROR: source is required and cannot be empty.",
      );
    }

    // Validate task
    const task = input.task as EditTask;
    if (task.type !== "edit" || !task.instruction?.trim()) {
      throw new Error(
        "VALIDATION_ERROR: task must be of type 'edit' with a non-empty instruction.",
      );
    }

    // Get API key from environment
    const apiKey = process.env.FAST_APPLY_API_KEY;
    if (!apiKey) {
      throw new Error(
        "PROVIDER_AUTH_FAILED: FAST_APPLY_API_KEY environment variable is not set.",
      );
    }

    // Validate context length (estimated tokens = total chars / 4)
    const estimatedTokens = Math.floor(
      (input.source.length + task.instruction.length) / 4,
    );
    if (estimatedTokens > MAX_CONTEXT_TOKENS) {
      throw new Error(
        `CONTEXT_EXCEEDED: Input exceeds maximum context length. Estimated tokens: ${estimatedTokens}`,
      );
    }

    // Validate file size (line count)
    const lineCount = input.source.split("\n").length;
    if (lineCount > MAX_CODE_LINES) {
      throw new Error(
        `VALIDATION_ERROR: Source too large: ${lineCount} lines exceeds maximum of ${MAX_CODE_LINES} lines.`,
      );
    }

    // Build prompt
    const prompt = buildPrompt(input.source, task.instruction);

    // Call API with retry
    let rawResponse: string;
    try {
      rawResponse = await withRetry(async () => {
        return callOpenAiCompatibleApi(
          endpointUrl,
          apiKey,
          modelName,
          prompt,
        );
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error("TIMEOUT: Request timed out.");
        }
        if (
          error.message.includes("401") ||
          error.message.includes("403")
        ) {
          throw new Error(
            "PROVIDER_AUTH_FAILED: Authentication failed. Check your API key.",
          );
        }
        throw new Error(`API_ERROR: ${error.message}`);
      }
      throw new Error("UNKNOWN_ERROR: An unknown error occurred.");
    }

    // Parse output with structure validation
    const result = parseOutput(rawResponse, input.source);

    if (!result.success) {
      throw new Error(
        `GENERATION_FAILED (${result.error}): ${result.details}`,
      );
    }

    return { result: result.updated_code! };
  }
}
