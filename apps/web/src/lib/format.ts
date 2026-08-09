import type { AppLocale } from '@/context/AppSettings';

export function formatNumber(
  value: number | string | null | undefined,
  locale: AppLocale = 'zh-TW',
): string {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    Number.isFinite(number) ? number : 0,
  );
}

export function formatCompact(
  value: number | string | null | undefined,
  locale: AppLocale = 'zh-TW',
): string {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number.isFinite(number) ? number : 0);
}

export function formatUsd(
  value: number | string | null | undefined,
  locale: AppLocale = 'zh-TW',
): string {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: number > 0 && number < 0.01 ? 4 : 2,
    maximumFractionDigits: 6,
  }).format(Number.isFinite(number) ? number : 0);
}

export function formatDateTime(
  value: string | null | undefined,
  locale: AppLocale = 'zh-TW',
): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
