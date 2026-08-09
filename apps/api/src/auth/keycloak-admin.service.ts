import { Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { loadRuntimeConfig, readSecret } from '../config/runtime-config';
import { AppError } from '../common/errors';

type JsonObject = Record<string, unknown>;

interface ProvisionedUser {
  id: string;
  generatedTemporaryPassword?: string;
  newlyCreated: boolean;
}

@Injectable()
export class KeycloakAdminService {
  private readonly config = loadRuntimeConfig();
  private readonly realm = decodeURIComponent(
    /\/realms\/([^/]+)$/.exec(this.config.oidcIssuerUrl)?.[1] ?? 'spiderwebrouter',
  );

  async provisionUser(input: {
    email: string;
    displayName?: string | null;
    role: UserRole;
    active: boolean;
    temporaryPassword?: string;
  }): Promise<ProvisionedUser> {
    const token = await this.adminToken();
    const existing = await this.findByEmail(input.email, token);
    if (existing)
      throw new AppError(
        'invalid_request_error',
        409,
        'An authentication account with this email already exists.',
        'email',
      );
    const generatedTemporaryPassword = input.temporaryPassword
      ? undefined
      : randomBytes(24).toString('base64url');
    const temporaryPassword = input.temporaryPassword ?? generatedTemporaryPassword!;
    const nameParts = (input.displayName ?? '').trim().split(/\s+/);
    const response = await this.request('/users', token, 'POST', {
      username: input.email,
      email: input.email,
      emailVerified: true,
      enabled: input.active,
      firstName: nameParts[0] || undefined,
      lastName: nameParts.slice(1).join(' ') || undefined,
      totp: false,
      requiredActions: ['UPDATE_PASSWORD'],
      credentials: [{ type: 'password', value: temporaryPassword, temporary: true }],
    });
    await this.expect(response, 'create user');
    const created = await this.findByEmail(input.email, token);
    const id = created?.id;
    if (typeof id !== 'string')
      throw new AppError('provider_unavailable', 503, 'Authentication service is unavailable.');
    try {
      await this.assignRole(id, input.role, token);
    } catch (error) {
      await this.request(`/users/${encodeURIComponent(id)}`, token, 'DELETE').catch(
        () => undefined,
      );
      throw error;
    }
    return { id, generatedTemporaryPassword, newlyCreated: true };
  }

  async updateUser(
    id: string,
    input: { displayName?: string | null; role?: UserRole; active?: boolean },
  ): Promise<void> {
    const token = await this.adminToken();
    const response = await this.request(`/users/${encodeURIComponent(id)}`, token);
    await this.expect(response, 'read user');
    const current = (await response.json()) as JsonObject;
    const nameParts = input.displayName?.trim().split(/\s+/);
    await this.expect(
      await this.request(`/users/${encodeURIComponent(id)}`, token, 'PUT', {
        ...current,
        enabled: input.active ?? current.enabled,
        firstName: nameParts ? nameParts[0] : current.firstName,
        lastName: nameParts ? nameParts.slice(1).join(' ') : current.lastName,
        totp: current.totp ?? false,
      }),
      'update user',
    );
    if (input.role) await this.assignRole(id, input.role, token);
  }

  async deleteUser(id: string): Promise<void> {
    const token = await this.adminToken();
    const response = await this.request(`/users/${encodeURIComponent(id)}`, token, 'DELETE');
    if (!response.ok && response.status !== 404) await this.expect(response, 'delete user');
  }

  private async assignRole(userId: string, role: UserRole, token: string): Promise<void> {
    const response = await this.request(`/roles/${encodeURIComponent(role)}`, token);
    await this.expect(response, 'read role');
    const representation = (await response.json()) as JsonObject;
    const mappingsResponse = await this.request(
      `/users/${encodeURIComponent(userId)}/role-mappings/realm`,
      token,
    );
    await this.expect(mappingsResponse, 'read user role mappings');
    const mappings = (await mappingsResponse.json()) as JsonObject[];
    const managedRoles = new Set(['USER', 'ADMIN', 'SUPER_ADMIN']);
    const obsolete = mappings.filter(
      (mapping) =>
        typeof mapping.name === 'string' && managedRoles.has(mapping.name) && mapping.name !== role,
    );
    if (obsolete.length) {
      await this.expect(
        await this.request(
          `/users/${encodeURIComponent(userId)}/role-mappings/realm`,
          token,
          'DELETE',
          obsolete,
        ),
        'remove obsolete roles',
      );
    }
    await this.expect(
      await this.request(
        `/users/${encodeURIComponent(userId)}/role-mappings/realm`,
        token,
        'POST',
        [representation],
      ),
      'assign role',
    );
  }

  private async findByEmail(email: string, token: string): Promise<JsonObject | undefined> {
    const response = await this.request(
      `/users?exact=true&email=${encodeURIComponent(email)}`,
      token,
    );
    await this.expect(response, 'find user');
    const users = (await response.json()) as JsonObject[];
    return users[0];
  }

  private async adminToken(): Promise<string> {
    const username = process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin';
    const password = readSecret('KEYCLOAK_ADMIN_PASSWORD');
    if (!password)
      throw new AppError('provider_unavailable', 503, 'Authentication service is unavailable.');
    try {
      const response = await fetch(
        `${this.config.keycloakBaseUrl}/realms/master/protocol/openid-connect/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'admin-cli',
            grant_type: 'password',
            username,
            password,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = (await response.json()) as JsonObject;
      if (!response.ok || typeof body.access_token !== 'string')
        throw new Error('Keycloak admin authentication failed');
      return body.access_token;
    } catch (error) {
      throw new AppError(
        'provider_unavailable',
        503,
        'Authentication service is unavailable.',
        null,
        error,
      );
    }
  }

  private request(path: string, token: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(
      `${this.config.keycloakBaseUrl}/admin/realms/${encodeURIComponent(this.realm)}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    ).catch((error: unknown) => {
      throw new AppError(
        'provider_unavailable',
        503,
        'Authentication service is unavailable.',
        null,
        error,
      );
    });
  }

  private async expect(response: Response, action: string): Promise<void> {
    if (response.ok) return;
    await response.body?.cancel();
    throw new AppError(
      'provider_unavailable',
      503,
      'Authentication service is unavailable.',
      null,
      new Error(`Keycloak failed to ${action} (HTTP ${response.status})`),
    );
  }
}
