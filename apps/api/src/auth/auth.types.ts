import type { UserRole } from '@prisma/client';

export interface AuthenticatedPrincipal {
  userId: string;
  subject: string;
  email: string;
  role: UserRole;
  apiKeyId?: string;
  apiKeyName?: string;
}

export interface RequestWithPrincipal {
  id: string;
  headers: Record<string, string | string[] | undefined>;
  principal?: AuthenticatedPrincipal;
}
