import { DisconnectOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Skeleton, Space, Typography } from 'antd';
import type { PropsWithChildren, ReactNode } from 'react';

import type { ApiError } from '@/api/client';
import { useAppSettings } from '@/context/AppSettings';

export function PageSkeleton() {
  return (
    <div className="surface-card page-skeleton" aria-busy="true">
      <Skeleton active paragraph={{ rows: 6 }} />
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  compact = false,
}: {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { tr } = useAppSettings();
  const unavailable = error.status === 0 || error.status >= 500;
  return (
    <Alert
      className={compact ? undefined : 'surface-card'}
      type="error"
      showIcon
      icon={unavailable ? <DisconnectOutlined /> : <SafetyCertificateOutlined />}
      message={
        unavailable
          ? tr('服務暫時無法連線', 'Service temporarily unavailable')
          : tr('無法載入資料', 'Unable to load data')
      }
      description={
        <Space direction="vertical" size={4}>
          <Typography.Text>{error.message}</Typography.Text>
          {error.requestId ? (
            <Typography.Text type="secondary" copyable={{ text: error.requestId }}>
              {tr('追蹤編號', 'Request ID')}: {error.requestId}
            </Typography.Text>
          ) : null}
          {onRetry ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
              {tr('重新整理', 'Try again')}
            </Button>
          ) : null}
        </Space>
      }
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{title}</Typography.Text>
          {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
        </Space>
      }
    >
      {action}
    </Empty>
  );
}

export function Surface({ children }: PropsWithChildren) {
  return <section className="surface-card">{children}</section>;
}
