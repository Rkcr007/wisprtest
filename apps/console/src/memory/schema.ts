import {
  Alias,
  ElementRecord,
  EntitySchema,
  NavEdge,
  ScreenNode,
  SeedLedgerEntry,
  Session,
} from 'protocol';
import { z } from 'zod';

/**
 * Gateway browse payloads the console parses.
 *
 * Not in `packages/protocol`: Track G added the routes inline. Parsed here so a shape drift
 * becomes a named load error rather than an empty table that looks like "no memory".
 */

export const ScreenList = z.object({
  applicationId: z.uuid(),
  memoryVersionId: z.uuid().nullable(),
  screens: z.array(ScreenNode),
  total: z.number().int().min(0),
});
export type ScreenList = z.infer<typeof ScreenList>;

export const ElementList = z.object({
  applicationId: z.uuid(),
  memoryVersionId: z.uuid().nullable(),
  elements: z.array(ElementRecord),
  total: z.number().int().min(0),
});
export type ElementList = z.infer<typeof ElementList>;

export const GraphList = z.object({
  applicationId: z.uuid(),
  memoryVersionId: z.uuid().nullable(),
  edges: z.array(NavEdge),
});
export type GraphList = z.infer<typeof GraphList>;

export const AliasList = z.object({
  applicationId: z.uuid(),
  memoryVersionId: z.uuid().nullable(),
  aliases: z.array(Alias),
  total: z.number().int().min(0),
});
export type AliasList = z.infer<typeof AliasList>;

export const ApplicationSchemas = z.object({
  applicationId: z.uuid(),
  memoryVersionId: z.uuid().nullable(),
  schemas: z.array(EntitySchema),
});
export type ApplicationSchemas = z.infer<typeof ApplicationSchemas>;

export const SessionList = z.object({
  sessions: z.array(Session),
  total: z.number().int().min(0),
});
export type SessionList = z.infer<typeof SessionList>;

export const SessionLedger = z.object({
  sessionId: z.uuid(),
  entries: z.array(SeedLedgerEntry),
});
export type SessionLedger = z.infer<typeof SessionLedger>;
