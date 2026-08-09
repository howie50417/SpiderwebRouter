import {
  ApiOutlined,
  ArrowRightOutlined,
  LockOutlined,
  RadarChartOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Space, Tag, Typography } from 'antd';
import { useLocation } from 'react-router-dom';

import { loginHref } from '@/auth/provider';
import { sanitizeReturnTo } from '@/auth/returnTo';
import { useAppSettings } from '@/context/AppSettings';

export function LoginPage() {
  const location = useLocation();
  const { locale, setLocale, tr } = useAppSettings();
  const params = new URLSearchParams(location.search);
  const returnTo = sanitizeReturnTo(params.get('returnTo'));
  const expired = params.get('reason') === 'expired';

  return (
    <main className="login-page">
      <section className="login-hero">
        <div className="login-brand">
          <div className="brand-mark brand-mark--large">
            <RadarChartOutlined />
          </div>
          <Typography.Text>SpiderwebRouter</Typography.Text>
        </div>
        <div className="login-hero__content">
          <Tag bordered={false} color="cyan">
            MODEL GATEWAY CONSOLE
          </Tag>
          <Typography.Title>
            {tr(
              '把每個模型來源，變成一個可靠的介面。',
              'One reliable interface for every model source.',
            )}
          </Typography.Title>
          <Typography.Paragraph>
            {tr(
              '集中管理供應商、模型授權、價格與完整用量，並以 OpenAI 相容 API 安全交付。',
              'Manage providers, model access, pricing, and usage from one secure OpenAI-compatible gateway.',
            )}
          </Typography.Paragraph>
          <div className="login-feature-grid">
            <Space>
              <ApiOutlined /> OpenAI-compatible
            </Space>
            <Space>
              <SafetyCertificateOutlined /> {tr('權限隔離', 'Access isolation')}
            </Space>
            <Space>
              <LockOutlined /> {tr('安全憑證', 'Protected secrets')}
            </Space>
          </div>
        </div>
        <Typography.Text className="login-footnote">
          Chat Completions · Responses · Embeddings
        </Typography.Text>
      </section>

      <section className="login-panel">
        <div className="login-language">
          <Button
            type="text"
            size="small"
            onClick={() => setLocale(locale === 'zh-TW' ? 'en-US' : 'zh-TW')}
          >
            {locale === 'zh-TW' ? 'English' : '繁體中文'}
          </Button>
        </div>
        <Card className="login-card" bordered={false}>
          <Space direction="vertical" size={24} className="full-width">
            {expired ? (
              <Alert
                type="warning"
                showIcon
                message={tr('登入狀態已過期', 'Your session has expired')}
                description={tr(
                  '請重新登入，完成後會回到原本的頁面。',
                  'Sign in again and you will return to the page you were viewing.',
                )}
              />
            ) : null}
            <div>
              <Typography.Title level={2}>
                {tr('登入控制台', 'Sign in to the console')}
              </Typography.Title>
              <Typography.Paragraph type="secondary">
                {tr(
                  '使用管理員建立的帳號繼續。首次登入時需要設定新密碼。',
                  'Continue with an administrator-provisioned account. You will set a new password on first sign-in.',
                )}
              </Typography.Paragraph>
            </div>
            <Button
              type="primary"
              size="large"
              block
              href={loginHref(returnTo)}
              icon={<ArrowRightOutlined />}
              iconPosition="end"
            >
              {tr('使用單一登入繼續', 'Continue with single sign-on')}
            </Button>
            <div className="login-security-note">
              <SafetyCertificateOutlined />
              <Typography.Text type="secondary">
                {tr(
                  '登入由獨立身分服務安全處理；控制台不會接觸您的密碼。',
                  'Authentication is handled by the identity service; this console never sees your password.',
                )}
              </Typography.Text>
            </div>
          </Space>
        </Card>
      </section>
    </main>
  );
}
