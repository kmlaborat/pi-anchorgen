# Pi Package Implementation Specification (Machine-Consumable Contract)

## 1. Purpose

Build a single package integrating extensions and skills for the Pi coding editor.

Define a complete specification that allows downstream implementation agents to immediately transition to code generation without interpretation or speculation.

Eliminate ambiguous expressions and enforce testable states. Speculation before implementation is not permitted.

## 2. Inputs

* **Package Manager**: `npm`
* **Environment**: Node.js (Directly evaluated in the `jiti` environment built into Pi editor without compilation)
* **Platform-Dependent Libraries**:
  * `@earendil-works/pi-coding-agent` (Provides type definitions for ExtensionAPI, events, etc.)

* **Source Directory Paths**:
  * `package.json` (Root manifest)
  * `extensions/` (Extension files)
  * `skills/<skill-name>/` (Skill definition directories)

## 3. Outputs

An executable and self-contained npm package. The file structure must strictly follow the format below.

```text
.
├── package.json
├── extensions/
│   └── index.ts
└── skills/
    └── standard-skill/
        └── SKILL.md
```

## 4. Invariants

1. **Manifest Invariant**: `package.json` must always include `"keywords": ["pi-package"]`. This makes it detectable in Pi's package gallery.

2. **Dependency Invariant**: Pi core libraries (`@earendil-works/pi-coding-agent`, etc.) must never be bundled within the package. Always specify in `peerDependencies` with the `"*"` range.

3. **Extension Signature Invariant**: The extension entry point (`extensions/index.ts`) must always define a `default export` function (synchronous or asynchronous) that takes `ExtensionAPI` as an argument.

4. **Lifecycle Invariant**: Starting background resources (timers, file watchers, subprocesses) must not be done at module load time (directly under the factory function). Always defer until after the `session_start` event, and clean up idempotently at the `session_shutdown` event.

5. **Skill Frontmatter Invariant**: All `SKILL.md` files must have YAML frontmatter at the beginning of the file and must include `name` (64 characters or less, lowercase letters, numbers, and hyphens only) and `description` (1024 characters or less).

## 5. Failure Cases

* **Condition**: Placing and loading a `SKILL.md` with missing `description`.
* **Expected Behavior**: The Pi agent ignores the skill without loading it. The implementation should treat this as a fatal validation error before deployment.

* **Condition**: Network communication hangs (does not complete) within the extension's asynchronous factory function.
* **Expected Behavior**: Subsequent lifecycle events such as `session_start` at Pi startup are completely blocked. The implementation must implement clear timeouts for asynchronous processing during initialization to avoid infinite blocking.

* **Condition**: Importing modules that depend on `devDependencies` at runtime.
* **Expected Behavior**: Since Pi installs packages equivalent to `npm install --omit=dev`, a `Module not found` error causes the load to crash. All external libraries required at runtime must be listed in `dependencies`.

---

## 6. TDD Task Breakdown

Downstream implementation agents must test and implement in the following order.
The order of `Requirement` -> `Acceptance Test` -> `Implementation Strategy` must not be changed.

### Requirement 1: Package Manifest Configuration

**Requirement**

The package must explicitly declare specified metadata and directory paths so that the Pi editor can automatically resolve resources (extensions and skills).

**Acceptance Test**

1. Is `"pi-package"` included in the `keywords` array of `package.json`?
2. Does `@earendil-works/pi-coding-agent` exist in `peerDependencies` of `package.json` with the value `"*"`?
3. Does the `"pi"` object exist in `package.json` with arrays for `"extensions": ["./extensions"]` and `"skills": ["./skills"]` as properties?

**Implementation Strategy**

Generate a standard `package.json` in the root directory. Following TDD principles, do not add dynamic build scripts or uncertain dependencies, and construct the minimal static JSON that meets the requirements.

---

### Requirement 2: Extension Entry Point and Type Definition

**Requirement**

Extensions must be correctly evaluated and executed via the `ExtensionAPI` interface from the Pi editor at runtime.

**Acceptance Test**

1. Does `extensions/index.ts` exist?
2. Is `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` declared at the beginning of the file?
3. Is `export default function(pi: ExtensionAPI)` (or async version) declared?

**Implementation Strategy**

Create `extensions/index.ts` and declare a type-safe function signature. Do not include business logic internally at this task stage.

---

### Requirement 3: Lifecycle Events and Resource Management

**Requirement**

Extensions must hook into the Pi editor's lifecycle (session start and end) and safely manage resources to prevent memory leaks.

**Acceptance Test**

1. Is the `pi.on("session_start", async (_event, ctx) => { ... })` event listener registered within the default function?
2. Is `pi.on("session_shutdown", async (_event, ctx) => { ... })` registered within the default function, and does it include processing to discard started resources (or a contract via comments)?
3. Are tool and command registrations (`pi.registerTool`, `pi.registerCommand`, etc.) called synchronously at the top level of the function, not within event handlers?

**Implementation Strategy**

Extend `extensions/index.ts` and add lifecycle subscriptions using `pi.on`. Explicitly show the symmetry of resource setup and cleanup as code structure.

---

### Requirement 4: Skill Definition and Metadata Validation

**Requirement**

The package must provide skill definitions that strictly comply with the Agent Skills specification so that LLM models can load them into context on demand.

**Acceptance Test**

1. Does `skills/standard-skill/SKILL.md` exist?
2. Is the first line of the file `---`?
3. Is `name: standard-skill` (lowercase, hyphens only, within 64 characters) strictly defined in the frontmatter?
4. Is `description:` (within 1024 characters, explaining when and how to use) defined in the frontmatter?
5. Is the frontmatter closed with `---`, and immediately after, is there a heading for `## Setup` or `## Usage` in Markdown format with a relative path to the implementation script?

**Implementation Strategy**

Create the `skills/standard-skill/` directory and generate `SKILL.md` as a static file that matches the specification. Focus on meeting the specification structure without excessive dependency on external tools.

---

## 7. Non-goals

The following are out of scope for this specification. Implementation agents must not speculate and implement these.

* Introduction of module bundlers such as Webpack or Rollup (not necessary as Pi editor uses `jiti` to load TypeScript directly).
* Advanced TUI (Terminal UI) custom rendering processing using UI components (`@earendil-works/pi-tui`).
* Actual publishing process to NPM registry or Git hosting services.
* Communication logic with external APIs (LLM providers, etc.) not included in the requirements of this specification.

---

***[Architect's Approval]***

This specification strictly defines external dependencies, edge cases, and invariants, and includes all information necessary for implementation. Downstream coding agents should treat this document as a direct contract and implement without deviation.
