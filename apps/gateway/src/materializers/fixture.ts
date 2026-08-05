import { randomUUID } from 'node:crypto';

import type { CompositionNode, InverseOperation, MaterializerDescriptor } from 'protocol';

import type { SeedJobDispatcher } from '../redis/seed-queue.js';
import type {
  MaterializationContext,
  MaterializationOutcome,
  MaterializationRefusal,
  Materializer,
  RevertContext,
} from './types.js';

/**
 * The fixture adapter: the seeding path the customer's own platform team sanctioned.
 *
 * docs/TEST-DATA-ENGINE.md § 4 gives it priority 0 and calls it "the adapter security review will
 * ask for". Nothing about it is learned — it is configured per application, and that is the whole
 * point: an endpoint a customer built for test data is faster and more reliable than anything
 * inferred from watching, and it is explicitly permitted rather than merely possible.
 *
 * ## `command` is an HTTP endpoint, and only that
 *
 * `MaterializerSpec`'s fixture variant types `command` as a free string, and § 4 describes the
 * adapter as an "endpoint, factory, or SQL". Running it as a shell command or a SQL statement is
 * remote code execution driven by a database column, so this implements the endpoint reading
 * only: the command is a URL, it is validated by the indexer's SSRF policy like every other
 * outbound request, and anything else is refused with a reason the tester can act on.
 *
 * A customer whose seeder is a rake task rather than a route cannot use this yet. That is a real
 * gap and it is stated in the refusal, which is better than a design where a column reaching
 * anywhere is the feature.
 *
 * ## What a fixture endpoint has to implement
 *
 * A create is `POST <command>` with the composed record as the JSON body, answering 2xx and naming
 * the record's identifier — in a `Location` header, or as an `id` in the response body. A teardown
 * is `POST <command>` with `{ entity, externalRef }`, answering 2xx, or 404 if the record is
 * already gone. Nothing about a customer's endpoint is observable the way an API materializer's
 * is, so this convention is the contract, and it is documented for whoever configures one.
 */

export interface FixtureMaterializerOptions {
  readonly dispatcher: SeedJobDispatcher;
  /** The teardown command configured for an entity, or null when the customer configured none. */
  readonly teardownFor: (entity: string) => string | null;
}

export function createFixtureMaterializer(options: FixtureMaterializerOptions): Materializer {
  return {
    kind: 'fixture',

    canHandle(
      _node: CompositionNode,
      descriptor: MaterializerDescriptor,
    ): MaterializationRefusal | null {
      if (descriptor.spec.kind !== 'fixture') {
        return { reason: 'the descriptor is not a fixture materializer' };
      }

      if (!isHttpUrl(descriptor.spec.command)) {
        return {
          reason:
            'the configured fixture command is not an http(s) endpoint — this adapter posts to a ' +
            'seeding route and will not run a shell command or a SQL statement from configuration',
        };
      }

      return null;
    },

    async materialize(
      node: CompositionNode,
      descriptor: MaterializerDescriptor,
      context: MaterializationContext,
    ): Promise<MaterializationOutcome> {
      if (descriptor.spec.kind !== 'fixture') {
        return { ok: false, failure: { reason: 'the descriptor is not a fixture materializer' } };
      }

      // A field pointing at another node holds that node's plan-local id until the node exists.
      const payload = Object.fromEntries(
        Object.entries(node.fields).map(([field, value]) => [
          field,
          context.created.get(String(value)) ?? value,
        ]),
      );

      const result = await options.dispatcher.run(
        {
          operation: 'fixture_create',
          jobId: randomUUID(),
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          memoryVersionId: context.memoryVersionId,
          sessionId: context.sessionId,
          planId: context.plan.id,
          nodeId: node.nodeId,
          entity: node.entity,
          command: descriptor.spec.command,
          payload,
          deadlineMs: context.deadlineMs,
        },
        context.deadlineMs,
      );

      if (result.outcome === 'failed' || result.externalRef === null) {
        return {
          ok: false,
          failure: { reason: result.failureReason ?? 'the fixture materializer created no record' },
        };
      }

      const teardown = options.teardownFor(node.entity);

      return {
        ok: true,
        record: {
          externalRef: result.externalRef,
          payload: { fields: node.fields, detailPath: null },
          inverseOp:
            teardown === null
              ? {
                  kind: 'none',
                  reason:
                    `${node.entity} was created through the configured seeding endpoint, and no ` +
                    'teardown command is configured for it — this record will remain',
                }
              : { kind: 'fixture', command: teardown },
        },
      };
    },

    async revert(
      inverseOp: InverseOperation,
      context: RevertContext,
    ): Promise<MaterializationRefusal | null> {
      if (inverseOp.kind === 'none') return { reason: inverseOp.reason };
      if (inverseOp.kind !== 'fixture') {
        return { reason: `the fixture adapter cannot run a ${inverseOp.kind} inverse operation` };
      }
      if (!isHttpUrl(inverseOp.command)) {
        return {
          reason:
            'the configured teardown command is not an http(s) endpoint, so this record has to be ' +
            'removed by hand',
        };
      }

      const result = await options.dispatcher.run(
        {
          operation: 'fixture_revert',
          jobId: randomUUID(),
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          memoryVersionId: context.memoryVersionId,
          entity: context.entity,
          externalRef: context.externalRef,
          command: inverseOp.command,
          deadlineMs: context.deadlineMs,
        },
        context.deadlineMs,
      );

      return result.outcome === 'succeeded'
        ? null
        : { reason: result.failureReason ?? 'the teardown did not remove the record' };
    },
  };
}

/**
 * Whether a configured command is something this adapter will post to.
 *
 * Scheme only. Where the URL is allowed to *point* is the indexer's decision, made against the
 * application's own allowlist by `crawl/url-policy.ts` — one SSRF gate, not two that could
 * disagree. This check exists so a rake task or a SQL string is refused with a useful sentence
 * here rather than as an opaque policy error three services away.
 */
function isHttpUrl(command: string): boolean {
  // Relative paths are the common case for a seeding route on the application's own origin, and
  // the policy resolves them against its base URL.
  if (command.startsWith('/')) return true;

  try {
    const url = new URL(command);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
