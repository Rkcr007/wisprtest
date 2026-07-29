import { ModelError, type ModelProvider, type ModelRequest } from '../../src/model/index.js';

/**
 * A scriptable T2 model, for driving the escalate route without a provider or the network.
 *
 * Every real behaviour the escalation service must handle has a reply kind here: a clean answer, a
 * body that does not parse (so the repair retry runs), a fast transport failure (so the fallback
 * runs), and a hang that resolves only when the request's own abort signal fires (so the 800 ms
 * budget produces a real timeout rather than a mocked one). The requests it received are captured,
 * which is how the redaction test proves no un-redacted candidate text ever reached a provider.
 */

export type FakeReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly error: ModelError }
  | { readonly kind: 'hang' };

export interface FakeModel {
  readonly provider: ModelProvider;
  /** Every request the provider was asked to complete, in order. */
  readonly requests: ModelRequest[];
}

/** A reply that is a valid escalation pick for `elementId`. */
export function pick(elementId: string, confidence: number, reasoning: string): FakeReply {
  return { kind: 'text', text: JSON.stringify({ elementId, confidence, reasoning }) };
}

export function createFakeModel(
  replies: readonly FakeReply[] | ((request: ModelRequest, callIndex: number) => FakeReply),
): FakeModel {
  const requests: ModelRequest[] = [];

  const provider: ModelProvider = {
    async complete(request) {
      const index = requests.length;
      requests.push(request);

      const reply = typeof replies === 'function' ? replies(request, index) : replies[index];
      if (reply === undefined) {
        throw new ModelError(
          'unavailable',
          request.model,
          `no scripted reply for call ${String(index)}`,
        );
      }
      if (reply.kind === 'error') throw reply.error;
      if (reply.kind === 'hang') {
        // Resolve nothing; reject when the service's deadline aborts us, exactly as the real
        // transport turns an AbortError into a `timeout` ModelError.
        return await new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new ModelError('timeout', request.model, 'model call aborted'));
          });
        });
      }
      return { text: reply.text, model: request.model };
    },
  };

  return { provider, requests };
}
