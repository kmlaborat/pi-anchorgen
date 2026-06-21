/**
 * Generator interface for AnchorGen-style code generation.
 *
 * Defines the contract between callers (tools, extensions) and
 * generator implementations (FastApplyGenerator, etc.).
 */

/** Input supplied to a generator. */
export interface GenerationInput {
  /** The source code or text to transform. */
  source: string;
  /** Task-specific data (e.g. instruction, update_snippet). */
  task: unknown;
}

/** Output produced by a generator. */
export interface GenerationOutput {
  /** The generated replacement text. */
  result: string;
}

/**
 * A code/text generator.
 *
 * Implementations receive a source and a task, perform generation
 * (typically via an LLM call), and return the result.
 */
export interface Generator {
  generate(input: GenerationInput): Promise<GenerationOutput>;
}
