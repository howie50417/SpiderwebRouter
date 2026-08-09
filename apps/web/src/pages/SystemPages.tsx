import { HomeOutlined, LockOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Result } from 'antd';
import { Link } from 'react-router-dom';

import { useAppSettings } from '@/context/AppSettings';

export function ForbiddenPage() {
  const { tr } = useAppSettings();
  return (
    <Result
      status="403"
      icon={<LockOutlined />}
      title="403"
      subTitle={tr(
        '你沒有權限檢視這個管理功能。',
        'You do not have access to this administrative feature.',
      )}
      extra={
        <Link to="/">
          <Button type="primary" icon={<HomeOutlined />}>
            {tr('返回總覽', 'Back to overview')}
          </Button>
        </Link>
      }
    />
  );
}

export function NotFoundPage() {
  const { tr } = useAppSettings();
  return (
    <Result
      status="404"
      icon={<WarningOutlined />}
      title="404"
      subTitle={tr('找不到這個頁面。', 'This page could not be found.')}
      extra={
        <Link to="/">
          <Button type="primary" icon={<HomeOutlined />}>
            {tr('返回總覽', 'Back to overview')}
          </Button>
        </Link>
      }
    />
  );
}
