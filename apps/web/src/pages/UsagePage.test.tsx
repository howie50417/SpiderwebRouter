import { App as AntApp } from 'antd';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiClient } from '@/api/client';
import type { UsageResponse } from '@/types';

const tableState = vi.hoisted(() => ({
  request: undefined as ((params: Record<string, unknown>) => Promise<unknown>) | undefined,
}));

vi.mock('@ant-design/pro-components', () => ({
  ProTable: (props: { request: (params: Record<string, unknown>) => Promise<unknown> }) => {
    tableState.request = props.request;
    return null;
  },
}));

vi.mock('@ant-design/charts', () => ({ Line: () => null }));
vi.mock('@refinedev/core', () => ({
  useGetIdentity: () => ({ data: { roles: ['USER'] } }),
}));
vi.mock('@/context/AppSettings', () => ({
  useAppSettings: () => ({
    locale: 'zh-TW',
    tr: (traditionalChinese: string) => traditionalChinese,
  }),
}));

import { UsagePage } from '@/pages/UsagePage';

const emptySummary = {
  requests: 0,
  failedRequests: 0,
  retries: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  amountUsd: '0',
  averageLatencyMs: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function response(id: string): UsageResponse {
  return {
    data: [{ id } as UsageResponse['data'][number]],
    total: 1,
    summary: emptySummary,
    series: [],
  };
}

describe('UsagePage request ordering', () => {
  beforeEach(() => {
    tableState.request = undefined;
    vi.restoreAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('refuses stale rows as well as stale overview data after a fast filter change', async () => {
    const slow = deferred<UsageResponse>();
    const latest = deferred<UsageResponse>();
    vi.spyOn(apiClient, 'get')
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(latest.promise);

    render(
      <AntApp>
        <UsagePage />
      </AntApp>,
    );
    const request = tableState.request;
    expect(request).toBeTypeOf('function');

    const slowResult = request!({ model: 'old-filter' });
    const latestResult = request!({ model: 'new-filter' });

    let accepted: unknown;
    await act(async () => {
      latest.resolve(response('new-row'));
      accepted = await latestResult;
    });
    expect(accepted).toMatchObject({
      data: [{ id: 'new-row' }],
      total: 1,
      success: true,
    });

    let stale: unknown;
    await act(async () => {
      slow.resolve(response('old-row'));
      stale = await slowResult;
    });
    expect(stale).toEqual({ data: [], total: 0, success: false });
  });
});
