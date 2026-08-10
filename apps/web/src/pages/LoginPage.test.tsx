import { App as AntApp } from 'antd';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  setLocale: vi.fn(),
  locale: 'zh-TW' as 'zh-TW' | 'en-US',
}));

vi.mock('@/context/AppSettings', () => ({
  useAppSettings: () => ({
    locale: settings.locale,
    setLocale: settings.setLocale,
    tr: (traditionalChinese: string, english: string) =>
      settings.locale === 'zh-TW' ? traditionalChinese : english,
  }),
}));

import { LoginPage } from '@/pages/LoginPage';

function renderLogin(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AntApp>
        <LoginPage />
      </AntApp>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    settings.setLocale.mockReset();
    settings.locale = 'zh-TW';
  });

  afterEach(() => {
    cleanup();
  });

  it('uses the product logo and preserves a safe return path after an expired session', () => {
    const { container } = renderLogin(
      '/login?reason=expired&returnTo=%2Fusage%3Fstatus%3DFAILED%23attempts',
    );

    expect(container.querySelector<HTMLImageElement>('.login-brand__logo')).toHaveAttribute(
      'src',
      '/logo.png',
    );
    expect(
      screen.getByText('登入已逾時，請重新登入。完成後會回到原本的頁面。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /使用單一登入繼續/ })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2Fusage%3Fstatus%3DFAILED%23attempts&locale=zh-TW',
    );
  });

  it('falls back to the home page for an unsafe return path', () => {
    renderLogin('/login?returnTo=%2F%2Fevil.example');

    expect(screen.getByRole('link', { name: /使用單一登入繼續/ })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2F&locale=zh-TW',
    );
  });

  it('renders the three design-spec benefits and keeps only the language control', () => {
    renderLogin('/login');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '一個介面，管好所有模型來源。',
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('供應商與授權集中管理')).toBeInTheDocument();
    expect(screen.getByText('價格與用量看得見')).toBeInTheDocument();
    expect(screen.getByText('OpenAI 相容 API 交付')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('shows the current language while switching to the other language', () => {
    const chinese = renderLogin('/login');

    fireEvent.click(screen.getByRole('button', { name: '切換語言，目前為中文' }));
    expect(screen.getByText('中文')).toBeInTheDocument();
    expect(settings.setLocale).toHaveBeenCalledWith('en-US');
    chinese.unmount();

    settings.locale = 'en-US';
    renderLogin('/login');
    fireEvent.click(screen.getByRole('button', { name: 'Switch language, currently English' }));
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(settings.setLocale).toHaveBeenCalledWith('zh-TW');
  });
});
