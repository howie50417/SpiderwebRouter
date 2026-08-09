import { describe, expect, it } from 'vitest';

import { createCreatedAtColumn } from '@/lib/createdAtColumn';
import { formatDateTime } from '@/lib/format';

interface TimestampedRow {
  createdAt: string;
}

describe('createdAt table column', () => {
  it('keeps date-range search but renders one row timestamp', () => {
    const column = createCreatedAtColumn<TimestampedRow>('Time', 'zh-TW', 180);
    const render = column.render as unknown as (
      defaultDom: unknown,
      row: TimestampedRow,
    ) => unknown;
    const rendered = render(null, { createdAt: '2026-08-09T11:52:21.970Z' });

    expect(column.valueType).toBe('dateRange');
    expect(rendered).toBe(formatDateTime('2026-08-09T11:52:21.970Z', 'zh-TW'));
  });

  it('uses the empty marker for a malformed timestamp', () => {
    const column = createCreatedAtColumn<TimestampedRow>('Time', 'en-US', 180);
    const render = column.render as unknown as (
      defaultDom: unknown,
      row: TimestampedRow,
    ) => unknown;

    expect(render(null, { createdAt: 'not-a-date' })).toBe('—');
  });
});
