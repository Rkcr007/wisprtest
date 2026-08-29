import { z } from 'zod';

const Role = z.enum(['viewer', 'tester', 'lead', 'owner']);

export const AdminUser = z.object({
  id: z.uuid(),
  email: z.string().min(1),
  role: Role,
  createdAt: z.iso.datetime(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUserList = z.object({
  users: z.array(AdminUser),
});
export type AdminUserList = z.infer<typeof AdminUserList>;

export const PatchUserRole = z.strictObject({
  role: Role,
});
export type PatchUserRole = z.infer<typeof PatchUserRole>;

export const AdminAuditList = z.object({
  entries: z.array(
    z.object({
      id: z.uuid(),
      actor: z.string(),
      action: z.string(),
      target: z.string(),
      metadata: z.unknown(),
      createdAt: z.iso.datetime(),
    }),
  ),
  total: z.number().int().min(0),
});
export type AdminAuditList = z.infer<typeof AdminAuditList>;

export const AdminPolicy = z.object({
  writable: z.literal(false),
  roles: z.array(Role),
  permissionsByRole: z.record(z.string(), z.array(z.string())),
  reversibility: z.array(
    z.object({
      class: z.string(),
      meaning: z.string(),
      speculative: z.boolean(),
      confirmation: z.boolean(),
      preStageOnly: z.boolean().optional(),
      previewRequired: z.boolean().optional(),
    }),
  ),
  redaction: z.object({
    stores: z.string(),
    accessibleNames: z.string(),
    masks: z.array(z.string()),
    elementTextInLogs: z.literal(false),
    customerDataInModelPrompts: z.literal(false),
    writable: z.literal(false),
  }),
});
export type AdminPolicy = z.infer<typeof AdminPolicy>;
