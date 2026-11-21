import { AppError } from './errors.ts';
import type { Role } from './types.ts';

export type Permission =
  | 'org:read' | 'org:manage' | 'org:delete' | 'billing:manage'
  | 'members:read' | 'members:manage'
  | 'project:create' | 'project:read' | 'project:delete'
  | 'spec:upload' | 'spec:read'
  | 'comparison:run' | 'comparison:read' | 'report:export'
  | 'policy:read' | 'policy:write'
  | 'integration:manage' | 'audit:read' | 'ai:explain';

const VIEWER: Permission[] = ['org:read', 'members:read', 'project:read', 'spec:read', 'comparison:read', 'policy:read', 'report:export'];
const MEMBER: Permission[] = [...VIEWER, 'project:create', 'spec:upload', 'comparison:run', 'ai:explain'];
const ADMIN: Permission[] = [...MEMBER, 'org:manage', 'members:manage', 'project:delete', 'policy:write', 'integration:manage', 'audit:read'];
const OWNER: Permission[] = [...ADMIN, 'org:delete', 'billing:manage'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER), MEMBER: new Set(MEMBER), ADMIN: new Set(ADMIN), OWNER: new Set(OWNER),
};
export const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export const can = (role: Role, p: Permission): boolean => MATRIX[role].has(p);

export function assertCan(role: Role, p: Permission): void {
  if (!can(role, p)) throw new AppError('FORBIDDEN', `Your role (${role}) cannot perform "${p}".`);
}
