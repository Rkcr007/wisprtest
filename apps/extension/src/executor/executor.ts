import {
  ActionResult,
  type ActionRequest,
  type ResolutionResult,
  type ScopedQuery,
  SessionStep,
} from 'protocol';

import { type CdpDispatcher, viewportPoint } from './cdp.js';
import { ENTER_KEY, ENTER_KEY_UP, keyEventsForChar } from './keymap.js';

/**
 * The ActionExecutor — the last step of `Remember → Execute`, and the only code that touches the
 * application under test on the tester's behalf.
 *
 * It takes a validated {@link ActionRequest} (whose reversibility refinements have already been
 * checked by the protocol schema) and a live element, dispatches the action, and emits a
 * {@link SessionStep} carrying the tier, latency, confidence, action class and evidence references
 * docs/BUILD-PLAN.md Phase 10 requires — for every action, executed or not.
 *
 * ## What goes through CDP, and what does not
 *
 * The trust-sensitive verbs — `click` (and the click that drives `navigate`) and `type`/`filter`
 * keystrokes — go through the {@link CdpDispatcher}, so an application that checks `isTrusted`
 * behaves as it would for a human (docs/ARCHITECTURE.md § 3). The rest — `focus`, `scroll`,
 * `back`, `select` — are not gated on trust in any real application and are done with the plain DOM
 * API, which is faster and needs no protocol round trip. Each choice is annotated at its case.
 *
 * ## The raw text never becomes a record
 *
 * `type`/`filter`/`select` need the *actual* characters to dispatch, but the persisted record must
 * not carry them — a tester may read a customer's email off the screen and ask to type it. So the
 * raw text arrives out of band on {@link DispatchContext.rawText}, held in memory only, while the
 * {@link ActionRequest} payload and the emitted step carry the redacted form. CLAUDE.md § "PII
 * rule": structure is persisted, content is not.
 */

export interface DispatchContext {
  readonly sessionId: string;
  /** Monotonic within the session; the step ingest is idempotent on `(sessionId, ordinal)`. */
  readonly ordinal: number;
  /** The redacted utterance, for the step. Raw transcript is never persisted. */
  readonly utterance: string;
  readonly intent: ScopedQuery;
  readonly resolution: ResolutionResult;
  /** `perf.now()` at speech onset, so the step's end-to-end latency spans the whole command. */
  readonly onsetAt: number;
  /**
   * The characters to actually type/select/filter. In-memory only, never logged or persisted;
   * when absent, the payload's (redacted) text is used, which is correct when it holds no PII.
   */
  readonly rawText?: string;
}

export interface ExecutorOptions {
  readonly dispatcher: CdpDispatcher;
  /** The window the target lives in — for scroll and history. */
  readonly window: Window;
  /** Milliseconds between keystrokes, so typing looks human to the application. */
  readonly interKeyDelayMs?: number;
  /** Monotonic clock for latency, defaulting to `performance.now`. Injected in tests and benches. */
  readonly now?: () => number;
  /** Wall clock for the ISO timestamps on the records. */
  readonly wallClock?: () => Date;
  /** The inter-key delay, injected so tests need not wait real milliseconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly idGen?: () => string;
  /** Where the emitted {@link SessionStep} goes — the session buffer wires this in Phase 12. */
  readonly onStep?: (step: SessionStep) => void;
}

export interface ActionExecutor {
  /** Dispatch a validated action against a live element, emit its step, and report the result. */
  dispatch(request: ActionRequest, element: Element, context: DispatchContext): Promise<ActionResult>;
}

const DEFAULT_INTER_KEY_MS = 24;
const DEFAULT_SCROLL_PX = 400;

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createActionExecutor(options: ExecutorOptions): ActionExecutor {
  const now = options.now ?? defaultNow;
  const wallClock = options.wallClock ?? (() => new Date());
  const sleep = options.sleep ?? realSleep;
  const interKeyDelayMs = options.interKeyDelayMs ?? DEFAULT_INTER_KEY_MS;
  const newId = options.idGen ?? (() => crypto.randomUUID());
  const { dispatcher, window } = options;

  async function click(element: Element): Promise<void> {
    const { x, y } = viewportPoint(element);
    await dispatcher.mouse({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await dispatcher.mouse({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async function typeText(element: Element, text: string, clearFirst: boolean): Promise<void> {
    if (element instanceof HTMLElement) element.focus();
    // Clearing is our own setup, not a keystroke the app should treat as trusted input, so it is a
    // direct write; the characters that follow are the trusted part.
    if (clearFirst && 'value' in element) (element as HTMLInputElement).value = '';

    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      if (char === undefined) continue;
      for (const event of keyEventsForChar(char)) await dispatcher.key(event);
      if (i < chars.length - 1) await sleep(interKeyDelayMs);
    }
  }

  function scroll(direction: 'up' | 'down' | 'top' | 'bottom', amountPx: number | null): void {
    const amount = amountPx ?? DEFAULT_SCROLL_PX;
    switch (direction) {
      case 'top':
        window.scrollTo(0, 0);
        return;
      case 'bottom':
        window.scrollTo(0, window.document.documentElement.scrollHeight);
        return;
      case 'up':
        window.scrollBy(0, -amount);
        return;
      case 'down':
        window.scrollBy(0, amount);
        return;
    }
  }

  function selectOption(element: Element, option: string): void {
    // Native <select> dropdowns cannot be opened through Input events; the reliable, generic path
    // is to move the selection to the matching option and fire `change`, which is what a framework
    // listens for. Value first, then visible label — an app may key either.
    if (!(element instanceof HTMLSelectElement)) return;
    const wanted = option.trim().toLowerCase();
    const match = [...element.options].find(
      (o) => o.value.toLowerCase() === wanted || o.textContent.trim().toLowerCase() === wanted,
    );
    if (match === undefined) return;
    element.selectedIndex = match.index;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function perform(
    request: ActionRequest,
    element: Element,
    context: DispatchContext,
  ): Promise<void> {
    const payload = request.payload;
    const text = context.rawText ?? ('text' in payload ? payload.text : '');

    switch (payload.verb) {
      // Trusted click, and the click that effects a navigation. `navigate`'s reversibility class is
      // R (see classify.ts) even though the DOM primitive is a click: the class is about undoing the
      // effect, and a navigation is undone by going back.
      case 'click':
      case 'navigate':
        await click(element);
        return;
      case 'type':
        await typeText(element, text, payload.clearFirst);
        return;
      case 'filter':
        // A text filter: type the value, then Enter to apply it.
        await typeText(element, text, true);
        await dispatcher.key(ENTER_KEY);
        await dispatcher.key(ENTER_KEY_UP);
        return;
      case 'focus':
        if (element instanceof HTMLElement) element.focus();
        return;
      case 'scroll':
        scroll(payload.direction, payload.amountPx);
        return;
      case 'select':
        selectOption(element, context.rawText ?? payload.option);
        return;
      case 'back':
        window.history.back();
        return;
      // An assertion reads and (from Phase 12) captures evidence; it mutates nothing here.
      case 'check':
        return;
    }
  }

  return {
    async dispatch(request, element, context): Promise<ActionResult> {
      const startedAt = now();
      let outcome: ActionResult['outcome'] = 'executed';
      let reason: string | null = null;

      try {
        await perform(request, element, context);
      } catch (error: unknown) {
        outcome = 'failed';
        reason = error instanceof Error ? `${error.name}: ${error.message}` : 'dispatch failed';
      }

      const finishedAt = now();
      const completedAt = wallClock().toISOString();

      const result = ActionResult.parse({
        actionRequestId: request.id,
        outcome,
        // Dispatch latency, measured from commit — the budget is p95 < 30 ms (CLAUDE.md).
        latencyMs: finishedAt - startedAt,
        reason,
        evidence: [],
        completedAt,
      });

      options.onStep?.(
        SessionStep.parse({
          id: newId(),
          sessionId: context.sessionId,
          ordinal: context.ordinal,
          utterance: context.utterance,
          intent: context.intent,
          resolution: context.resolution,
          elementId: request.elementId,
          tier: request.tier,
          confidence: request.confidence,
          actionClass: request.actionClass,
          // End to end: speech onset → completion, the number the session timeline shows.
          latencyMs: finishedAt - context.onsetAt,
          outcome,
          evidence: [],
          createdAt: completedAt,
        }),
      );

      return result;
    },
  };
}
