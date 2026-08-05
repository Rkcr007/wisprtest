import { randomUUID } from 'node:crypto';

import type {
  CompositionNode,
  EntitySchema,
  InverseOperation,
  MaterializerDescriptor,
  UiSeedFieldValue,
} from 'protocol';

import type { SeedJobDispatcher } from '../redis/seed-queue.js';
import type {
  MaterializationContext,
  MaterializationOutcome,
  MaterializationRefusal,
  Materializer,
  RevertContext,
} from './types.js';

/**
 * The UI adapter: an RPC client for the browser that lives on the indexer.
 *
 * All the difficult work — resolving controls by fingerprint, filling them, submitting, reading
 * the identifier back — is in `apps/indexer/src/seed/materializer.ts`, because that is where
 * Playwright and the per-application auth profiles are. What is left here is the part that
 * belongs to the gateway: turning a plan node into a job, and turning a job result into something
 * the ledger can hold.
 *
 * ## Translating a node into controls
 *
 * The plan speaks in schema fields; the form speaks in controls. `control_element_key` on each
 * `FieldSpec` is the join, recorded by the form observer when the form was indexed (§ 2.1). A
 * field with no control is one this adapter cannot write, and saying so in `canHandle` is what
 * lets the chain fall through to an adapter that can, rather than submitting a form with a
 * required field left blank.
 */

export interface UiMaterializerOptions {
  readonly dispatcher: SeedJobDispatcher;
  /** Schemas of the memory version being seeded, keyed by entity schema id. */
  readonly schemas: ReadonlyMap<string, EntitySchema>;
  /** The indexed delete flow per entity name, or null when none was found. */
  readonly deleteFlows: ReadonlyMap<string, string>;
}

export function createUiMaterializer(options: UiMaterializerOptions): Materializer {
  return {
    kind: 'ui',

    canHandle(
      node: CompositionNode,
      descriptor: MaterializerDescriptor,
    ): MaterializationRefusal | null {
      if (descriptor.spec.kind !== 'ui') {
        return { reason: 'the descriptor is not a UI materializer' };
      }

      const schema = options.schemas.get(node.entitySchemaId);
      if (schema === undefined) {
        return { reason: `no learned schema for ${node.entity} in this memory version` };
      }

      const unwritable = Object.keys(node.fields).filter((field) => {
        const spec = schema.fields.find((candidate) => candidate.name === field);
        return spec?.controlElementKey == null;
      });

      if (unwritable.length > 0) {
        return {
          reason:
            `the create form has no indexed control for ${unwritable.join(', ')}, so the record ` +
            'cannot be written through the UI',
        };
      }

      return null;
    },

    async materialize(
      node: CompositionNode,
      descriptor: MaterializerDescriptor,
      context: MaterializationContext,
    ): Promise<MaterializationOutcome> {
      if (descriptor.spec.kind !== 'ui') {
        return { ok: false, failure: { reason: 'the descriptor is not a UI materializer' } };
      }

      const schema = options.schemas.get(node.entitySchemaId);
      if (schema === undefined) {
        return {
          ok: false,
          failure: { reason: `no learned schema for ${node.entity} in this memory version` },
        };
      }

      const values: UiSeedFieldValue[] = [];
      for (const [field, value] of Object.entries(node.fields)) {
        const spec = schema.fields.find((candidate) => candidate.name === field);
        if (spec?.controlElementKey == null) {
          return {
            ok: false,
            failure: { reason: `the create form has no indexed control for ${field}` },
          };
        }
        values.push({
          field,
          controlElementKey: spec.controlElementKey,
          // A field pointing at another node holds that node's plan-local id until the node is
          // created. Substituting the real identifier here is how a dependency edge is honoured.
          value: context.created.get(String(value)) ?? value,
        });
      }

      if (values.length === 0) {
        return { ok: false, failure: { reason: 'the plan node has no fields to fill' } };
      }

      const result = await options.dispatcher.run(
        {
          operation: 'ui_create',
          jobId: randomUUID(),
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          memoryVersionId: context.memoryVersionId,
          sessionId: context.sessionId,
          planId: context.plan.id,
          nodeId: node.nodeId,
          entity: node.entity,
          form: descriptor.spec.form,
          route: descriptor.spec.route,
          values,
          deadlineMs: context.deadlineMs,
        },
        context.deadlineMs,
      );

      if (result.outcome === 'failed' || result.externalRef === null) {
        return {
          ok: false,
          failure: {
            reason: result.failureReason ?? 'the UI materializer did not create a record',
          },
        };
      }

      return {
        ok: true,
        record: {
          externalRef: result.externalRef,
          // The record's own path travels in the payload because the ledger is where a revert
          // reads from, and a list-row delete control cannot be aimed without it. It is the
          // application's own answer about where the record lives, not a reconstruction.
          payload: { fields: node.fields, detailPath: result.detailPath },
          inverseOp: inverseFor(node.entity, options.deleteFlows),
        },
      };
    },

    async revert(
      inverseOp: InverseOperation,
      context: RevertContext,
    ): Promise<MaterializationRefusal | null> {
      if (inverseOp.kind === 'none') {
        return { reason: inverseOp.reason };
      }
      if (inverseOp.kind !== 'ui') {
        return { reason: `the UI adapter cannot run a ${inverseOp.kind} inverse operation` };
      }
      if (context.detailPath === null) {
        return {
          reason:
            `the ledger holds no path for ${context.externalRef}, so the delete control cannot ` +
            'be aimed at the right record',
        };
      }

      const result = await options.dispatcher.run(
        {
          operation: 'ui_revert',
          jobId: randomUUID(),
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          memoryVersionId: context.memoryVersionId,
          entity: context.entity,
          flow: inverseOp.flow,
          externalRef: context.externalRef,
          detailPath: context.detailPath,
          deadlineMs: context.deadlineMs,
        },
        context.deadlineMs,
      );

      return result.outcome === 'succeeded'
        ? null
        : { reason: result.failureReason ?? 'the delete flow did not remove the record' };
    },
  };
}

/**
 * How a record created through the UI will be removed.
 *
 * TEST-DATA-ENGINE § 5: `none` is a real answer, not a failure, and it has to be visible in the
 * preview *before* the record is created. A tester deciding whether to seed something that cannot
 * be removed deserves to know up front — which is why this is decided from indexed knowledge and
 * not discovered at revert time.
 */
function inverseFor(entity: string, deleteFlows: ReadonlyMap<string, string>): InverseOperation {
  const flow = deleteFlows.get(entity);
  if (flow === undefined) {
    return {
      kind: 'none',
      reason: `no delete control for ${entity} was found when this application was indexed`,
    };
  }
  return { kind: 'ui', flow };
}
