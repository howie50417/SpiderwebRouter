import { App as AntApp } from 'antd';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  toggleColorMode: vi.fn(),
}));

vi.mock('@/context/AppSettings', () => ({
  useAppSettings: () => ({
    colorMode: 'light',
    locale: 'zh-TW',
    setLocale: vi.fn(),
    toggleColorMode: settings.toggleColorMode,
    tr: (traditionalChinese: string) => traditionalChinese,
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
    settings.toggleColorMode.mockReset();
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
    expect(screen.getByText('登入狀態已過期')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /使用單一登入繼續/ })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2Fusage%3Fstatus%3DFAILED%23attempts',
    );
  });

  it('falls back to the home page for an unsafe return path', () => {
    renderLogin('/login?returnTo=%2F%2Fevil.example');

    expect(screen.getByRole('link', { name: /使用單一登入繼續/ })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2F',
    );
  });

  it('keeps the appearance switch available on the sign-in page', () => {
    renderLogin('/login');

    fireEvent.click(screen.getByRole('button', { name: '切換為深色模式' }));
    expect(settings.toggleColorMode).toHaveBeenCalledOnce();
  });
});
