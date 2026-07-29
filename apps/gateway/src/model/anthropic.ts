import {
  ModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './provider.js';

/**
 * The real T2 model provider: Anthropic's Messages API.
 *
 * This is the production path CLAUDE.md rule #1 requires to be real rather than stubbed. It is a
 * transport and nothing more — it signs the request, enforces the caller's abort signal, and
 * turns the two failure shapes that matter (a non-2xx, a body that is not the documented shape)
 * into a typed {@link ModelError} the escalation service branches on. Redaction, JSON validation,
 * repair retries and the primary/fallback choice all live above it, so this file has no product
 * logic to drift.
 *
 * The API key never appears in a log line or an error message: `ModelError` carries the model id,
 * never the credential, and the key is read from validated config, not from an argument that
 * might be logged at a call site.
 */

/** Pinned per Anthropic's API: the version header is required and gates response compatibility. */
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Base URL, so a test or a proxy can point elsewhere without touching this code. */
  readonly baseUrl: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The subset of the Messages response this transport reads. */
interface AnthropicMessage {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = new URL('/v1/messages', options.baseUrl).href;

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }),
          signal: request.signal,
        });
      } catch (error: unknown) {
        // An aborted fetch throws an AbortError; the caller reads `timeout` and returns the typed
        // resolution_timeout rather than waiting. Anything else here is the network being down.
        if (isAbort(error)) {
          throw new ModelError('timeout', request.model, 'model call aborted', { cause: error });
        }
        throw new ModelError('unavailable', request.model, 'model provider unreachable', {
          cause: error,
        });
      }

      if (!response.ok) {
        // The body may carry the provider's own error detail; it is read for the log, never for
        // the client, and the key is not in it. A 429 or 5xx is `unavailable` — a fast failure a
        // fallback can still beat the budget on — while the abort path above owns the timeout.
        throw new ModelError(
          'unavailable',
          request.model,
          `model provider returned ${String(response.status)}`,
        );
      }

      let body: AnthropicMessage;
      try {
        body = (await response.json()) as AnthropicMessage;
      } catch (error: unknown) {
        throw new ModelError('malformed', request.model, 'model response was not JSON', {
          cause: error,
        });
      }

      const text = (body.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
        .join('');

      if (text.trim() === '') {
        throw new ModelError('malformed', request.model, 'model response carried no text');
      }

      return { text, model: request.model };
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
