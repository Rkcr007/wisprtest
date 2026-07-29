import type { ActionVerb } from 'protocol';

/**
 * Rollback records — the entire reason the reversibility taxonomy exists.
 *
 * CLAUDE.md § "Reversibility taxonomy": "Rollback applies only to class R. That is the entire
 * reason the taxonomy exists." A class-R action may be executed on a *partial* speech hypothesis,
 * before the tester has finished the sentence, precisely because its effect can be captured and
 * undone if the next revision names a different target. This module captures that inverse the
 * instant before the speculative effect is applied, and replays it if the hypothesis diverges.
 *
 * ## Why rollback uses the DOM directly, not CDP
 *
 * The forward action goes through CDP so the application sees a *trusted* event (ActionExecutor).
 * The rollback does not: it is WisprTest correcting its own speculation, not the tester acting, so
 * restoring a scroll position or a field value with a plain DOM write is both correct and faster.
 * Nothing downstream should treat a rollback as user input — and a synthetic, untrusted restore is
 * exactly how you signal that.
 *
 * ## What is captured, per verb
 *
 * Only the R verbs reach here — `click` is class C and never speculative, so it never has a record.
 * `check` is an assertion that mutates nothing, so its record is a no-op. The rest each restore the
 * one piece of state their forward action touched:
 *
 * | Verb            | Captured before                | Restored on divergence           |
 * |-----------------|--------------------------------|----------------------------------|
 * | focus           | the previously focused element | refocus it (or blur the target)  |
 * | scroll          | the scroll offsets it moved    | scroll back to them              |
 * | type / filter   | the field value and caret      | restore the value, re-fire input |
 * | select          | the control's value            | restore it, re-fire change       |
 * | navigate / back | the history position           | step the other way               |
 */

export interface RollbackRecord {
  /** The verb whose effect this undoes, kept for logging and the session step's evidence. */
  readonly verb: ActionVerb;
  /** Undo the speculative effect. Called at most once, by the speculation controller. */
  apply(): void;
}

export interface RollbackContext {
  /** The window the target lives in, for history and scroll offsets. */
  readonly window: Window;
}

/** A control that carries a `value` — the shape type/filter/select roll back. */
interface Valued extends Element {
  value: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

function isValued(element: Element): element is Valued {
  return 'value' in element && typeof (element as { value?: unknown }).value === 'string';
}

/** Re-fire the event an application listens on, so its own state tracks the restored value. */
function fire(element: Element, type: 'input' | 'change'): void {
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

/**
 * Capture the inverse of a class-R action, to be applied if the hypothesis that triggered it is
 * later revised. Returns `null` when there is nothing to undo — an unknown verb, or a `check`.
 *
 * Called synchronously, immediately before the forward action is dispatched, so the "before" it
 * reads is genuinely before.
 */
export function captureRollback(
  verb: ActionVerb,
  element: Element,
  ctx: RollbackContext,
): RollbackRecord | null {
  const { window } = ctx;

  switch (verb) {
    case 'focus': {
      const previous = element.ownerDocument.activeElement;
      return {
        verb,
        apply(): void {
          if (previous instanceof HTMLElement) previous.focus();
          else if (element instanceof HTMLElement) element.blur();
        },
      };
    }

    case 'scroll': {
      // The forward scroll moves the window unless the target is itself a scroll container; capture
      // whichever it will move so the restore targets the same thing.
      const container = scrollContainerFor(element);
      if (container === null) {
        const x = window.scrollX;
        const y = window.scrollY;
        return {
          verb,
          apply(): void {
            window.scrollTo(x, y);
          },
        };
      }
      const left = container.scrollLeft;
      const top = container.scrollTop;
      return {
        verb,
        apply(): void {
          container.scrollLeft = left;
          container.scrollTop = top;
        },
      };
    }

    case 'type':
    case 'filter': {
      if (!isValued(element)) return null;
      const value = element.value;
      const selectionStart = element.selectionStart ?? null;
      const selectionEnd = element.selectionEnd ?? null;
      return {
        verb,
        apply(): void {
          element.value = value;
          if (selectionStart !== null && 'setSelectionRange' in element) {
            try {
              (element as HTMLInputElement).setSelectionRange(
                selectionStart,
                selectionEnd ?? selectionStart,
              );
            } catch {
              // A number/email input throws on setSelectionRange; the value restore is what matters.
            }
          }
          fire(element, 'input');
        },
      };
    }

    case 'select': {
      if (!isValued(element)) return null;
      const value = element.value;
      return {
        verb,
        apply(): void {
          element.value = value;
          fire(element, 'change');
        },
      };
    }

    case 'navigate': {
      return {
        verb,
        apply: () => {
          window.history.back();
        },
      };
    }

    case 'back': {
      return {
        verb,
        apply: () => {
          window.history.forward();
        },
      };
    }

    // Assertions mutate nothing; a click is never speculative so it never reaches capture.
    case 'check':
    case 'click':
      return null;
  }
}

/** The nearest ancestor (or the element) that actually scrolls, or null when the window scrolls. */
function scrollContainerFor(element: Element): Element | null {
  let node: Element | null = element;
  while (node !== null) {
    if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      const overflow = `${style?.overflowY ?? ''} ${style?.overflowX ?? ''}`;
      if (/(auto|scroll|overlay)/.test(overflow)) return node;
    }
    node = node.parentElement;
  }
  return null;
}
