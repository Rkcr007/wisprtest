import { randomUUID } from 'node:crypto';

import {
  MemorySnapshot as MemorySnapshotSchema,
  type MemorySnapshot,
  type NavEdge,
  type NavPrecondition,
} from 'protocol';

import type { IndexedScreen, ObservedEdge } from '../crawl/crawler.js';

/**
 * Turn an in-memory crawl into the same {@link MemorySnapshot} the gateway would assemble
 * from Postgres. The dump CLI is how a live app is indexed without the Compose stack: the
 * crawler is the real one, the persistence is a file, the contract is identical.
 */

export interface AssembledScreen {
  readonly id: string;
  readonly indexed: IndexedScreen;
  /** elementKey → element id, scoped to this screen. */
  readonly elementIds: ReadonlyMap<string, string>;
}

export interface AssembleInput {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  readonly generatedAt: string;
  readonly screens: readonly AssembledScreen[];
  readonly edges: readonly ObservedEdge[];
  readonly idGen?: () => string;
}

/** Assemble a contract-valid snapshot from a finished crawl. */
export function assembleSnapshot(input: AssembleInput): MemorySnapshot {
  const idGen = input.idGen ?? randomUUID;
  const indexedAt = input.generatedAt;

  const screens = input.screens.map((screen) => ({
    id: screen.id,
    memoryVersionId: input.memoryVersionId,
    routePattern: screen.indexed.routePattern,
    stateFingerprint: screen.indexed.stateFingerprint,
    label: screen.indexed.label,
    structuralHash: screen.indexed.structuralHash,
    indexedAt,
  }));

  const elements = input.screens.flatMap((screen) =>
    screen.indexed.elements.map((element) => {
      const id = screen.elementIds.get(element.elementKey);
      if (id === undefined) {
        throw new Error(`dump assembler missing id for ${element.elementKey} on ${screen.id}`);
      }
      return {
        id,
        screenId: screen.id,
        elementKey: element.elementKey,
        fingerprint: element.fingerprint,
        confidence: element.confidence,
        // First version: no previous memory to re-resolve against. Same reading as the job
        // runner when `previousVersionId` is null.
        stability: 0,
      };
    }),
  );

  const edges: NavEdge[] = [];
  for (const edge of input.edges) {
    const from = input.screens.find((screen) => screen.id === edge.fromScreenId);
    const triggerElementId = from?.elementIds.get(edge.triggerElementKey);
    if (triggerElementId === undefined) continue;

    const preconditions: NavPrecondition[] = [
      { kind: 'route_matches', routePattern: edge.fromRoutePattern },
      { kind: 'element_visible', elementKey: edge.triggerElementKey },
    ];

    edges.push({
      id: idGen(),
      memoryVersionId: input.memoryVersionId,
      fromScreenId: edge.fromScreenId,
      toScreenId: edge.toScreenId,
      triggerElementId,
      preconditions,
      confidence: edge.confidence,
    });
  }

  const snapshot: MemorySnapshot = {
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    memoryVersion: {
      id: input.memoryVersionId,
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      version: 1,
      status: 'active',
      createdAt: input.generatedAt,
      approvedBy: null,
      failureReason: null,
    },
    screens,
    elements,
    navEdges: edges,
    aliases: [],
    generatedAt: input.generatedAt,
  };

  return MemorySnapshotSchema.parse(snapshot);
}
