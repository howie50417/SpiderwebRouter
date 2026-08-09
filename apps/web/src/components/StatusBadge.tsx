import { Badge, Tag } from 'antd';

const statusMap: Record<string, { color: string; label: string }> = {
  HEALTHY: { color: 'success', label: 'Healthy' },
  DEGRADED: { color: 'warning', label: 'Degraded' },
  UNHEALTHY: { color: 'error', label: 'Unhealthy' },
  UNKNOWN: { color: 'default', label: 'Unknown' },
  SUCCEEDED: { color: 'success', label: 'Succeeded' },
  FAILED: { color: 'error', label: 'Failed' },
  PENDING: { color: 'processing', label: 'Pending' },
  CANCELLED: { color: 'default', label: 'Cancelled' },
};

export function StatusBadge({ status }: { status: string }) {
  const normalized = statusMap[status] ?? {
    color: 'default',
    label: status,
  };
  return <Tag color={normalized.color}>{normalized.label}</Tag>;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return <Badge status={enabled ? 'success' : 'default'} text={enabled ? 'Enabled' : 'Disabled'} />;
}
