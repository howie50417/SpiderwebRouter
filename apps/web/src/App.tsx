import { ProConfigProvider } from '@ant-design/pro-components';
import { useNotificationProvider } from '@refinedev/antd';
import { Authenticated, Refine } from '@refinedev/core';
import routerProvider, {
  DocumentTitleHandler,
  UnsavedChangesNotifier,
} from '@refinedev/react-router-v6';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhTW from 'antd/locale/zh_TW';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { dataProvider } from '@/api/dataProvider';
import { authProvider } from '@/auth/provider';
import { consoleLoginHref, sanitizeReturnTo } from '@/auth/returnTo';
import { AdminGuard } from '@/components/AdminGuard';
import { AppLayout } from '@/components/AppLayout';
import { useAppSettings } from '@/context/AppSettings';
import { LoginPage } from '@/pages/LoginPage';

const ApiKeysPage = lazy(() =>
  import('@/pages/ApiKeysPage').then((module) => ({ default: module.ApiKeysPage })),
);
const AuditPage = lazy(() =>
  import('@/pages/AuditPage').then((module) => ({ default: module.AuditPage })),
);
const DashboardPage = lazy(() =>
  import('@/pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const DocsPage = lazy(() =>
  import('@/pages/DocsPage').then((module) => ({ default: module.DocsPage })),
);
const ModelsPage = lazy(() =>
  import('@/pages/ModelsPage').then((module) => ({ default: module.ModelsPage })),
);
const PlaygroundPage = lazy(() =>
  import('@/pages/PlaygroundPage').then((module) => ({ default: module.PlaygroundPage })),
);
const ProvidersPage = lazy(() =>
  import('@/pages/ProvidersPage').then((module) => ({ default: module.ProvidersPage })),
);
const UsagePage = lazy(() =>
  import('@/pages/UsagePage').then((module) => ({ default: module.UsagePage })),
);
const UsersPage = lazy(() =>
  import('@/pages/UsersPage').then((module) => ({ default: module.UsersPage })),
);
const ForbiddenPage = lazy(() =>
  import('@/pages/SystemPages').then((module) => ({ default: module.ForbiddenPage })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/SystemPages').then((module) => ({ default: module.NotFoundPage })),
);

function ProtectedLoginRedirect() {
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return <Navigate to={consoleLoginHref(returnTo)} replace />;
}

function SignedInRedirect() {
  const location = useLocation();
  const returnTo = sanitizeReturnTo(new URLSearchParams(location.search).get('returnTo'));
  return <Navigate to={returnTo} replace />;
}

function ConsoleApp() {
  const { colorMode, locale, reducedMotion } = useAppSettings();
  const notificationProvider = useNotificationProvider();

  return (
    <ConfigProvider
      locale={locale === 'zh-TW' ? zhTW : enUS}
      theme={{
        algorithm: colorMode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#14b8a6',
          colorInfo: '#2dd4bf',
          colorSuccess: '#22c55e',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          borderRadius: 10,
          motion: !reducedMotion,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        components: {
          Card: { paddingLG: 22 },
          Table: { headerBg: colorMode === 'dark' ? '#101c2d' : '#f7fafc' },
          Button: { primaryShadow: 'none' },
        },
      }}
    >
      <AntApp>
        <ProConfigProvider hashed={false} dark={colorMode === 'dark'}>
          <Refine
            routerProvider={routerProvider}
            authProvider={authProvider}
            dataProvider={dataProvider}
            notificationProvider={notificationProvider}
            resources={[
              { name: 'dashboard', list: '/' },
              { name: 'providers', list: '/providers' },
              { name: 'models', list: '/models' },
              { name: 'users', list: '/users' },
              { name: 'usage', list: '/usage' },
              { name: 'audit', list: '/audit' },
              { name: 'keys', list: '/api-keys' },
            ]}
            options={{
              syncWithLocation: true,
              warnWhenUnsavedChanges: true,
              useNewQueryKeys: true,
            }}
          >
            <Suspense
              fallback={
                <div className="route-loading">
                  <span className="route-loading__spinner" />
                </div>
              }
            >
              <Routes>
                <Route
                  path="/login"
                  element={
                    <Authenticated key="login" fallback={<LoginPage />}>
                      <SignedInRedirect />
                    </Authenticated>
                  }
                />
                <Route
                  element={
                    <Authenticated key="protected" fallback={<ProtectedLoginRedirect />}>
                      <AppLayout />
                    </Authenticated>
                  }
                >
                  <Route index element={<DashboardPage />} />
                  <Route element={<AdminGuard />}>
                    <Route path="providers" element={<ProvidersPage />} />
                    <Route path="models" element={<ModelsPage />} />
                    <Route path="users" element={<UsersPage />} />
                    <Route path="audit" element={<AuditPage />} />
                  </Route>
                  <Route path="usage" element={<UsagePage />} />
                  <Route path="api-keys" element={<ApiKeysPage />} />
                  <Route path="playground" element={<PlaygroundPage />} />
                  <Route path="docs" element={<DocsPage />} />
                  <Route path="forbidden" element={<ForbiddenPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </Suspense>
            <UnsavedChangesNotifier />
            <DocumentTitleHandler
              handler={({ resource }) =>
                `${resource?.meta?.label ?? resource?.name ?? 'Console'} · SpiderwebRouter`
              }
            />
          </Refine>
        </ProConfigProvider>
      </AntApp>
    </ConfigProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ConsoleApp />
    </BrowserRouter>
  );
}
