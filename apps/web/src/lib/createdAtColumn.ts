import type { ProColumns } from '@ant-design/pro-components';

import type { AppLocale } from '@/context/AppSettings';
import { formatDateTime } from '@/lib/format';

interface TimestampedRecord {
  createdAt: string;
}

/**
 * Creates a timestamp column that keeps a date-range control in the search
 * form while rendering each table row's single createdAt timestamp.
 */
export function createCreatedAtColumn<T extends TimestampedRecord>(
  title: string,
  locale: AppLocale,
  width: number,
): ProColumns<T> {
  return {
    title,
    dataIndex: 'createdAt',
    valueType: 'dateRange',
    width,
    fixed: 'left',
    render: (_defaultDom, row) => formatDateTime(row.createdAt, locale),
  };
}
