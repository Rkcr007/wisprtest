/**
 * The T2 model provider and the escalation service that drives it.
 *
 * The route imports `runEscalation` and a `ModelProvider`; `main.ts` constructs the real
 * `createAnthropicProvider` from validated config; tests inject a fake `ModelProvider` so
 * `test:resolve` needs neither a key nor the network. That split is what lets the production path
 * be real (CLAUDE.md rule #1) while the suite stays hermetic.
 */
export type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelMessage,
  ModelErrorKind,
} from './provider.js';
export { ModelError } from './provider.js';
export { createAnthropicProvider } from './anthropic.js';
export type { AnthropicProviderOptions } from './anthropic.js';
export { runEscalation } from './escalate.js';
export type { EscalationDeps, EscalationOutcome } from './escalate.js';
export {
  ESCALATION_SYSTEM_PROMPT,
  ESCALATION_REPAIR_INSTRUCTION,
  buildUserPrompt,
  parseEscalation,
} from './prompt.js';
