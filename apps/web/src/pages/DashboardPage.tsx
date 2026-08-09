import {
  ApiOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  ReloadOutlined,
  RetweetOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Line, Pie } from '@ant-design/charts';
import { useGetIdentity } from '@refinedev/core';
import { Button, Card, Col, Progress, Row, Space, Statistic, Table, Tag, Typography } from 'antd';

import { apiClient } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { useApiResource } from '@/api/hooks';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/AsyncState';
import { PageIntro } from '@/components/PageIntro';
import { useAppSettings } from '@/context/AppSettings';
import { formatCompact, formatNumber, formatUsd } from '@/lib/format';
import type { DashboardData, Identity, RankedUsage } from '@/types';

const emptyDashboard: DashboardData = {
  summary: {
    requests: 0,
    failedRequests: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    amountUsd: '0',
    averageLatencyMs: 0,
  },
  series: [],
  topModels: [],
  topUsers: [],
  topApiKeys: [],
};

export function DashboardPage() {
  const { data: identity } = useGetIdentity<Identity>();
  const { locale, tr } = useAppSettings();
  const isAdmin = Boolean(identity?.roles.includes('SUPER_ADMIN'));
  const dashboard = useApiResource(
    async (signal) => {
      if (isAdmin) return apiClient.get<DashboardData>(endpoints.dashboard, undefined, signal);
      return apiClient.get<DashboardData>(endpoints.myDashboard, undefined, signal);
    },
    [isAdmin],
  );

  if (dashboard.loading && !dashboard.data) return <PageSkeleton />;
  if (dashboard.error && !dashboard.data) {
    return <ErrorState error={dashboard.error} onRetry={dashboard.refresh} />;
  }

  const data = dashboard.data ?? emptyDashboard;
  const { summary } = data;
  const errorRate = summary.requests ? (summary.failedRequests / summary.requests) * 100 : 0;
  const trendData = data.series.flatMap((point) => [
    { date: point.date, metric: tr('請求', 'Requests'), value: point.requests },
    { date: point.date, metric: tr('錯誤', 'Failures'), value: point.failures ?? 0 },
  ]);
  const tokenMix = [
    { type: tr('輸入', 'Input'), value: summary.inputTokens },
    { type: tr('輸出', 'Output'), value: summary.outputTokens },
  ].filter((item) => item.value > 0);

  const rankingColumns = [
    {
      title: tr('名稱', 'Name'),
      dataIndex: 'name',
      ellipsis: true,
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: tr('請求', 'Requests'),
      dataIndex: 'requests',
      align: 'right' as const,
      render: (value: number) => formatNumber(value, locale),
    },
    {
      title: 'Tokens',
      dataIndex: 'tokens',
      align: 'right' as const,
      render: (value: number) => formatCompact(value, locale),
    },
    {
      title: 'USD',
      dataIndex: 'amountUsd',
      align: 'right' as const,
      render: (value: string) => formatUsd(value, locale),
    },
  ];

  return (
    <>
      <PageIntro
        eyebrow={tr('控制台', 'Console')}
        title={`${tr('早安', 'Welcome')}${identity?.displayName ? `，${identity.displayName}` : ''}`}
        description={tr(
          '掌握最近 30 天的流量、成本與服務品質。',
          'Monitor traffic, cost, and service quality over the last 30 days.',
        )}
        actions={
          <Button icon={<ReloadOutlined />} loading={dashboard.loading} onClick={dashboard.refresh}>
            {tr('重新整理', 'Refresh')}
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card className="metric-card">
            <Statistic
              title={tr('總請求', 'Requests')}
              value={summary.requests}
              formatter={(value) => formatCompact(String(value), locale)}
              prefix={<ApiOutlined />}
            />
            <Typography.Text type="secondary">
              {formatNumber(summary.failedRequests, locale)} {tr('次失敗', 'failed')}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="metric-card metric-card--teal">
            <Statistic
              title={tr('總 Tokens', 'Total tokens')}
              value={summary.totalTokens}
              formatter={(value) => formatCompact(String(value), locale)}
              prefix={<ThunderboltOutlined />}
            />
            <Typography.Text type="secondary">
              {tr('輸入', 'Input')} {formatCompact(summary.inputTokens, locale)} ·{' '}
              {tr('輸出', 'Output')} {formatCompact(summary.outputTokens, locale)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="metric-card metric-card--amber">
            <Statistic
              title={tr('推估金額', 'Estimated amount')}
              value={Number(summary.amountUsd)}
              formatter={(value) => formatUsd(String(value), locale)}
              prefix={<DollarOutlined />}
            />
            <Typography.Text type="secondary">
              USD · {tr('依價格快照計算', 'priced from snapshots')}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="metric-card metric-card--violet">
            <Statistic
              title={tr('平均延遲', 'Average latency')}
              value={summary.averageLatencyMs}
              suffix="ms"
              formatter={(value) => formatNumber(String(value), locale)}
              prefix={<ClockCircleOutlined />}
            />
            <Typography.Text type="secondary">
              <RetweetOutlined /> {formatNumber(summary.retries, locale)} retries
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="dashboard-row">
        <Col xs={24} xl={16}>
          <Card
            title={tr('請求趨勢', 'Request trend')}
            extra={<Tag>{tr('最近 30 天', 'Last 30 days')}</Tag>}
            className="chart-card"
          >
            {trendData.length ? (
              <Line
                data={trendData}
                xField="date"
                yField="value"
                colorField="metric"
                height={288}
                axis={{ x: { labelAutoRotate: false } }}
                scale={{ color: { range: ['#14b8a6', '#f87171'] } }}
                interaction={{ tooltip: { shared: true } }}
              />
            ) : (
              <EmptyState title={tr('目前沒有趨勢資料', 'No trend data yet')} />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title={tr('Token 組成', 'Token mix')} className="chart-card">
            {tokenMix.length ? (
              <Pie
                data={tokenMix}
                angleField="value"
                colorField="type"
                innerRadius={0.67}
                height={240}
                scale={{ color: { range: ['#14b8a6', '#6366f1'] } }}
                legend={{ position: 'bottom' }}
              />
            ) : (
              <EmptyState title={tr('尚無 Token 用量', 'No token usage yet')} />
            )}
            <Space direction="vertical" className="full-width">
              <Space className="full-width progress-label">
                <Typography.Text type="secondary">{tr('錯誤率', 'Error rate')}</Typography.Text>
                <Typography.Text>{errorRate.toFixed(2)}%</Typography.Text>
              </Space>
              <Progress
                percent={Math.min(errorRate, 100)}
                showInfo={false}
                status={errorRate > 5 ? 'exception' : 'normal'}
              />
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="dashboard-row">
        <Col xs={24} xl={isAdmin ? 8 : 24}>
          <Card title={tr('熱門模型', 'Top models')}>
            <Table<RankedUsage>
              rowKey="name"
              size="small"
              pagination={false}
              dataSource={data.topModels}
              columns={rankingColumns}
              locale={{ emptyText: tr('尚無模型用量', 'No model usage yet') }}
            />
          </Card>
        </Col>
        {isAdmin ? (
          <Col xs={24} xl={8}>
            <Card title={tr('活躍使用者', 'Active users')}>
              <Table<RankedUsage>
                rowKey="name"
                size="small"
                pagination={false}
                dataSource={data.topUsers}
                columns={rankingColumns}
                locale={{ emptyText: tr('尚無使用者用量', 'No user usage yet') }}
              />
            </Card>
          </Col>
        ) : null}
        {isAdmin ? (
          <Col xs={24} xl={8}>
            <Card title={tr('熱門 API Keys', 'Top API keys')}>
              <Table<RankedUsage>
                rowKey="name"
                size="small"
                pagination={false}
                dataSource={data.topApiKeys ?? []}
                columns={rankingColumns}
                locale={{ emptyText: tr('尚無 API Key 用量', 'No API key usage yet') }}
              />
            </Card>
          </Col>
        ) : null}
      </Row>
    </>
  );
}
