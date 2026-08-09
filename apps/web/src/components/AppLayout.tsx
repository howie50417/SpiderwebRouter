import {
  ApiOutlined,
  AuditOutlined,
  BookOutlined,
  BulbOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MoonOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SunOutlined,
  TeamOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { ProLayout } from '@ant-design/pro-components';
import { useGetIdentity, useLogout } from '@refinedev/core';
import { Avatar, Button, Dropdown, Space, Tag, Tooltip, Typography } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAppSettings } from '@/context/AppSettings';
import type { Identity } from '@/types';

interface MenuRoute {
  path: string;
  name: string;
  icon: React.ReactNode;
  admin?: boolean;
}

export function AppLayout() {
  const { data: identity } = useGetIdentity<Identity>();
  const { mutate: logout } = useLogout();
  const location = useLocation();
  const navigate = useNavigate();
  const { colorMode, locale, setLocale, toggleColorMode, tr } = useAppSettings();
  const isAdmin = Boolean(identity?.roles.includes('SUPER_ADMIN'));

  const allRoutes: MenuRoute[] = [
    { path: '/', name: tr('總覽', 'Overview'), icon: <DashboardOutlined /> },
    {
      path: '/providers',
      name: tr('服務來源', 'Providers'),
      icon: <CloudServerOutlined />,
      admin: true,
    },
    {
      path: '/models',
      name: tr('模型目錄', 'Model catalog'),
      icon: <RobotOutlined />,
      admin: true,
    },
    {
      path: '/users',
      name: tr('使用者與授權', 'Users & grants'),
      icon: <TeamOutlined />,
      admin: true,
    },
    { path: '/usage', name: tr('用量', 'Usage'), icon: <ApiOutlined /> },
    {
      path: '/audit',
      name: tr('稽核日誌', 'Audit log'),
      icon: <AuditOutlined />,
      admin: true,
    },
    { path: '/api-keys', name: 'API Keys', icon: <KeyOutlined /> },
    {
      path: '/playground',
      name: 'Playground',
      icon: <PlayCircleOutlined />,
    },
    { path: '/docs', name: tr('API 文件', 'API docs'), icon: <BookOutlined /> },
  ];
  const routes = allRoutes.filter((route) => !route.admin || isAdmin);

  return (
    <ProLayout
      className="app-shell"
      layout="mix"
      fixedHeader
      fixSiderbar
      breakpoint="lg"
      title="SpiderwebRouter"
      logo={
        <div className="brand-mark" aria-hidden="true">
          <RobotOutlined />
        </div>
      }
      location={{ pathname: location.pathname }}
      route={{ path: '/', routes }}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      menuHeaderRender={(logo, title) => (
        <Link to="/" className="brand-link">
          {logo}
          {title}
        </Link>
      )}
      actionsRender={() => [
        <Tooltip key="theme" title={tr('切換明暗主題', 'Toggle color mode')}>
          <Button
            aria-label={tr('切換明暗主題', 'Toggle color mode')}
            type="text"
            icon={colorMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleColorMode}
          />
        </Tooltip>,
        <Dropdown
          key="locale"
          menu={{
            selectedKeys: [locale],
            items: [
              { key: 'zh-TW', label: '繁體中文' },
              { key: 'en-US', label: 'English' },
            ],
            onClick: ({ key }) => setLocale(key as 'zh-TW' | 'en-US'),
          }}
        >
          <Button type="text" icon={<TranslationOutlined />}>
            {locale === 'zh-TW' ? '繁中' : 'EN'}
          </Button>
        </Dropdown>,
      ]}
      avatarProps={{
        src: undefined,
        title: identity?.displayName ?? identity?.email ?? tr('載入中', 'Loading'),
        render: (_props, dom) => (
          <Dropdown
            menu={{
              items: [
                {
                  key: 'identity',
                  disabled: true,
                  label: (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>
                        {identity?.displayName ?? identity?.email}
                      </Typography.Text>
                      <Typography.Text type="secondary">{identity?.email}</Typography.Text>
                      {identity?.roles[0] ? <Tag>{identity.roles[0]}</Tag> : null}
                    </Space>
                  ),
                },
                { type: 'divider' },
                {
                  key: 'logout',
                  danger: true,
                  icon: <LogoutOutlined />,
                  label: tr('登出', 'Sign out'),
                  onClick: () => logout(),
                },
              ],
            }}
          >
            <Space className="avatar-trigger">
              <Avatar size="small">
                {(identity?.displayName ?? identity?.email ?? 'S')[0]?.toUpperCase()}
              </Avatar>
              {dom}
            </Space>
          </Dropdown>
        ),
      }}
      siderMenuType="sub"
      token={{
        header: { colorBgHeader: colorMode === 'dark' ? '#0b1627' : '#ffffff' },
        sider: { colorMenuBackground: colorMode === 'dark' ? '#08121f' : '#fbfcfe' },
      }}
      ErrorBoundary={false}
      onMenuHeaderClick={() => navigate('/')}
      collapsedButtonRender={(collapsed) => (
        <Tooltip
          title={collapsed ? tr('展開選單', 'Expand menu') : tr('收合選單', 'Collapse menu')}
        >
          <MenuFoldOutlined rotate={collapsed ? 180 : 0} />
        </Tooltip>
      )}
    >
      <main className="page-container">
        <Outlet />
      </main>
    </ProLayout>
  );
}
