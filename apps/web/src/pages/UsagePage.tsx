import {
  ApiOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  DownloadOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Line } from '@ant-design/charts';
import { ProTable, type ActionType, type ProColumns } from '@ant-design/pro-components';
import { useGetIdentity } from '@refinedev/core';
import type { DashboardSummary } from '@spiderwebrouter/contracts';
import { App, Button, Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';

import { apiClient, getSafeError, type ApiError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { EmptyState, ErrorState } from '@/components/AsyncState';
import { PageIntro } from '@/components/PageIntro';
import { StatusBadge } from '@/components/StatusBadge';
import { useAppSettings } from '@/context/AppSettings';
import { createCreatedAtColumn } from '@/lib/createdAtColumn';
import { downloadBlob, formatCompact, formatNumber, formatUsd } from '@/lib/format';
import {
  buildUsageQuery,
  createDefaultUsageDateRange,
  LatestUsageRequest,
  withoutUsagePagination,
} from '@/lib/usageQuery';
import type { Identity, ListQuery, UsageRecord, UsageResponse, UsageSeriesPoint } from '@/types';

const emptySummary: DashboardSummary = {
  requests: 0,
  failedRequests: 0,
  retries: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  amountUsd: '0',
  averageLatencyMs: 0,
};

interface UsageOverview {
  summary: DashboardSummary;
  series: UsageSeriesPoint[];
}

const emptyOverview: UsageOverview = { summary: emptySummary, series: [] };

export function UsagePage() {
  const tableRef = useRef<ActionType | undefined>(undefined);
  const defaultDateRange = useMemo(() => createDefaultUsageDateRange(), []);
  const latestFilters = useRef<ListQuery>(buildUsageQuery({}, defaultDateRange));
  const requestSequence = useRef(new LatestUsageRequest());
  const { data: identity } = useGetIdentity<Identity>();
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [exporting, setExporting] = useState(false);
  const [overview, setOverview] = useState<UsageOverview>(emptyOverview);
  const [overviewError, setOverviewError] = useState<ApiError>();
  const isAdmin = Boolean(identity?.roles.includes('SUPER_ADMIN'));
  const usageEndpoint = isAdmin ? endpoints.adminUsage : endpoints.myUsage;

  const notifyError = (reason: unknown) => {
    const error = getSafeError(reason);
    message.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`);
  };

  const exportUsage = async () => {
    setExporting(true);
    try {
      const blob = await apiClient.download(
        isAdmin ? endpoints.adminUsageCsv : endpoints.myUsageCsv,
        withoutUsagePagination(latestFilters.current),
      );
      downloadBlob(blob, `spiderwebrouter-usage-${new Date().toISOString().slice(0, 10)}.csv`);
      message.success(tr('CSV 已下載', 'CSV downloaded'));
    } catch (error) {
      notifyError(error);
    } finally {
      setExporting(false);
    }
  };

  const columns: ProColumns<UsageRecord>[] = [
    createCreatedAtColumn<UsageRecord>(tr('時間', 'Time'), locale, 180),
    ...(isAdmin
      ? ([
          {
            title: tr('使用者', 'User'),
            dataIndex: 'userEmail',
            copyable: true,
            width: 220,
          },
        ] satisfies ProColumns<UsageRecord>[])
      : []),
    {
      title: tr('模型', 'Model'),
      dataIndex: 'model',
      copyable: true,
      ellipsis: true,
      width: 190,
    },
    {
      title: 'API Key',
      dataIndex: 'apiKeyName',
      width: 150,
      renderText: (value) => value || tr('控制台', 'Console'),
    },
    {
      title: tr('介面', 'API'),
      dataIndex: 'kind',
      valueType: 'select',
      valueEnum: {
        CHAT: { text: 'Chat Completions' },
        RESPONSES: { text: 'Responses' },
        EMBEDDINGS: { text: 'Embeddings' },
      },
      width: 150,
    },
    {
      title: tr('來源', 'Source'),
      dataIndex: 'source',
      valueType: 'select',
      valueEnum: {
        API: { text: 'API' },
        PLAYGROUND: { text: 'Playground' },
        DOCS: { text: 'Docs' },
      },
      width: 120,
    },
    {
      title: tr('輸入', 'Input'),
      dataIndex: 'inputTokens',
      search: false,
      align: 'right',
      renderText: (value) => formatNumber(value, locale),
    },
    {
      title: tr('輸出', 'Output'),
      dataIndex: 'outputTokens',
      search: false,
      align: 'right',
      renderText: (value) => formatNumber(value, locale),
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      search: false,
      align: 'right',
      render: (_, row) => (
        <Space size={4}>
          {formatNumber(row.totalTokens, locale)}
          {row.estimated ? <Tag color="gold">estimated</Tag> : null}
        </Space>
      ),
    },
    {
      title: 'USD',
      dataIndex: 'amountUsd',
      search: false,
      align: 'right',
      renderText: (value) => formatUsd(value, locale),
    },
    {
      title: 'Retry',
      dataIndex: 'retries',
      search: false,
      align: 'right',
    },
    {
      title: tr('延遲', 'Latency'),
      dataIndex: 'latencyMs',
      search: false,
      align: 'right',
      renderText: (value) => `${formatNumber(value, locale)} ms`,
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'status',
      valueType: 'select',
      valueEnum: {
        RUNNING: { text: 'Running' },
        SUCCEEDED: { text: 'Succeeded' },
        FAILED: { text: 'Failed' },
        CANCELLED: { text: 'Cancelled' },
      },
      width: 120,
      render: (_, row) => <StatusBadge status={row.status} />,
    },
    {
      title: tr('追蹤編號', 'Request ID'),
      dataIndex: 'requestId',
      copyable: true,
      search: false,
      ellipsis: true,
      width: 150,
    },
  ];

  const { summary } = overview;
  const chartData = overview.series.flatMap((point) => [
    { date: point.date, metric: tr('請求', 'Requests'), value: point.requests },
    { date: point.date, metric: 'USD', value: point.amountUsd },
  ]);

  return (
    <>
      <PageIntro
        eyebrow={isAdmin ? tr('超管', 'Administration') : tr('開發者控制台', 'Developer console')}
        title={tr('用量與金額', 'Usage and spend')}
        description={tr(
          '每筆資料使用當次價格快照計算；estimated 表示上游未提供完整 usage，由系統估算。',
          'Each row uses its request-time price snapshot. Estimated usage is clearly marked when the provider omits token counts.',
        )}
        actions={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => tableRef.current?.reload()}>
              {tr('重新整理', 'Refresh')}
            </Button>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void exportUsage()}
            >
              {tr('匯出 CSV', 'Export CSV')}
            </Button>
          </>
        }
      />

      {overviewError ? (
        <ErrorState compact error={overviewError} onRetry={() => tableRef.current?.reload()} />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <Card className="metric-card metric-card--compact">
            <Statistic
              title={tr('請求', 'Requests')}
              prefix={<ApiOutlined />}
              value={summary.requests}
              formatter={(value) => formatCompact(String(value), locale)}
            />
            <Typography.Text type="secondary">
              {formatNumber(summary.failedRequests, locale)} {tr('次失敗', 'failed')}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="metric-card metric-card--compact">
            <Statistic
              title="Tokens"
              prefix={<ThunderboltOutlined />}
              value={summary.totalTokens}
              formatter={(value) => formatCompact(String(value), locale)}
            />
            <Typography.Text type="secondary">
              {tr('輸入', 'Input')} {formatCompact(summary.inputTokens, locale)} ·{' '}
              {tr('輸出', 'Output')} {formatCompact(summary.outputTokens, locale)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="metric-card metric-card--compact">
            <Statistic
              title="USD"
              prefix={<DollarOutlined />}
              value={Number(summary.amountUsd)}
              formatter={(value) => formatUsd(String(value), locale)}
            />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="metric-card metric-card--compact">
            <Statistic
              title={tr('平均延遲', 'Avg. latency')}
              prefix={<ClockCircleOutlined />}
              value={summary.averageLatencyMs}
              suffix="ms"
            />
            <Typography.Text type="secondary">
              {formatNumber(summary.retries, locale)} retries
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Card title={tr('所選期間趨勢', 'Selected-period trend')} className="chart-card usage-chart">
        {chartData.length ? (
          <Line
            data={chartData}
            xField="date"
            yField="value"
            colorField="metric"
            height={230}
            scale={{ color: { range: ['#14b8a6', '#8b5cf6'] } }}
            interaction={{ tooltip: { shared: true } }}
          />
        ) : (
          <EmptyState title={tr('尚無用量趨勢', 'No usage trend yet')} />
        )}
      </Card>

      <ProTable<UsageRecord>
        actionRef={tableRef}
        rowKey="id"
        columns={columns}
        cardBordered
        scroll={{ x: 1_750 }}
        search={{ labelWidth: 'auto', defaultCollapsed: false }}
        form={{ initialValues: { createdAt: defaultDateRange } }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          const requestId = requestSequence.current.begin();
          const query = buildUsageQuery(params, defaultDateRange);
          latestFilters.current = query;
          try {
            const result = await apiClient.get<UsageResponse>(usageEndpoint, query);
            // ProTable owns its row state separately from our summary cards. A
            // slower, older filter request must therefore be rejected before
            // it can hand stale rows back to ProTable as well.
            if (!requestSequence.current.isLatest(requestId)) {
              return { data: [], total: 0, success: false };
            }
            setOverview({
              summary: { ...emptySummary, ...result.summary },
              series: result.series ?? [],
            });
            setOverviewError(undefined);
            return { data: result.data, total: result.total, success: true };
          } catch (error) {
            if (requestSequence.current.isLatest(requestId)) {
              setOverview(emptyOverview);
              setOverviewError(getSafeError(error));
              notifyError(error);
            }
            return { data: [], total: 0, success: false };
          }
        }}
      />
    </>
  );
}
