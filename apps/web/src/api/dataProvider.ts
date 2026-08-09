import type { DataProvider } from '@refinedev/core';

import { apiClient } from '@/api/client';

const resourcePaths: Record<string, string> = {
  providers: '/admin/providers',
  models: '/admin/models',
  users: '/admin/users',
  usage: '/admin/usage',
  audit: '/admin/audit',
  keys: '/me/api-keys',
};

function pathFor(resource: string): string {
  return resourcePaths[resource] ?? `/${resource}`;
}

export const dataProvider: DataProvider = {
  getApiUrl: () => apiClient.baseUrl,
  getList: async ({ resource, pagination, sorters, filters }) => {
    const page = pagination?.current ?? 1;
    const pageSize = pagination?.pageSize ?? 20;
    const firstSort = sorters?.[0];
    const query: Record<string, string | number | undefined> = {
      page,
      pageSize,
      sort: firstSort?.field,
      order: firstSort?.order,
    };
    filters?.forEach((filter) => {
      if ('field' in filter && filter.value !== undefined) {
        query[String(filter.field)] = String(filter.value);
      }
    });
    return apiClient.list(pathFor(resource), query);
  },
  getOne: async ({ resource, id }) => ({
    data: await apiClient.get(`${pathFor(resource)}/${encodeURIComponent(String(id))}`),
  }),
  create: async ({ resource, variables }) => ({
    data: await apiClient.post(pathFor(resource), variables),
  }),
  update: async ({ resource, id, variables }) => ({
    data: await apiClient.patch(
      `${pathFor(resource)}/${encodeURIComponent(String(id))}`,
      variables,
    ),
  }),
  deleteOne: async ({ resource, id }) => ({
    data: await apiClient.delete(`${pathFor(resource)}/${encodeURIComponent(String(id))}`),
  }),
};
