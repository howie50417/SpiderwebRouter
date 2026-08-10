import { ArrowRightOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Typography } from 'antd';
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
      <section className="login-hero" aria-labelledby="login-hero-title">
        <div className="login-brand">
          <img className="login-brand__logo" src="/logo.png" alt="" aria-hidden="true" />
          <Typography.Text>SpiderwebRouter</Typography.Text>
        </div>
        <div className="login-hero__content">
          <Typography.Title id="login-hero-title">
            SpiderwebRouter
            <br />
            {tr('一鍵連結所有模型', 'Connect every model in one click')}
          </Typography.Title>
          <div className="login-benefits" role="list">
            <div className="login-benefit" role="listitem">
              <span className="login-benefit__number" aria-hidden="true">
                01
              </span>
              <div className="login-benefit__copy">
                <strong>
                  {tr('統一管理多模型資源', 'Unified management for multi-model resources')}
                </strong>
                <span>
                  {tr(
                    '一站整合所有專案共用模型與權限配置。',
                    'Manage shared models and access policies for every project in one place.',
                  )}
                </span>
              </div>
            </div>
            <div className="login-benefit" role="listitem">
              <span className="login-benefit__number" aria-hidden="true">
                02
              </span>
              <div className="login-benefit__copy">
                <strong>{tr('用量與費用清楚可見', 'Transparent usage and costs')}</strong>
                <span>
                  {tr(
                    '調用次數、Token、成本拆分清晰透明。',
                    'Calls, tokens, and costs are clearly broken down.',
                  )}
                </span>
              </div>
            </div>
            <div className="login-benefit" role="listitem">
              <span className="login-benefit__number" aria-hidden="true">
                03
              </span>
              <div className="login-benefit__copy">
                <strong>{tr('標準 API，無縫整合', 'Standard APIs, seamless integration')}</strong>
                <span>
                  {tr(
                    '支援 OpenAI 相容接口，既有程式可快速對接。',
                    'OpenAI-compatible APIs let existing applications connect quickly.',
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
        <Typography.Text className="login-footnote">
          Chat Completions · Responses · Embeddings
        </Typography.Text>
      </section>

      <section className="login-panel" aria-label={tr('控制台登入', 'Console sign-in')}>
        <div className="login-controls">
          <Button
            className="login-control login-language"
            type="text"
            size="small"
            aria-label={tr('切換語言，目前為中文', 'Switch language, currently English')}
            title={tr('切換至英文', 'Switch to Traditional Chinese')}
            onClick={() => setLocale(locale === 'zh-TW' ? 'en-US' : 'zh-TW')}
          >
            {locale === 'zh-TW' ? '中文' : 'English'}
          </Button>
        </div>
        <Card className="login-card" variant="borderless">
          <div className="login-card__content">
            {expired ? (
              <Alert
                className="login-expired-alert"
                type="warning"
                showIcon
                message={tr(
                  '登入已逾時，請重新登入。完成後會回到原本的頁面。',
                  'Your session has expired. Sign in again and you will return to the page you were viewing.',
                )}
              />
            ) : null}
            <div className="login-card__heading">
              <Typography.Title level={2}>
                {tr('登入控制台', 'Sign in to the console')}
              </Typography.Title>
              <Typography.Paragraph className="login-card__description" type="secondary">
                {tr(
                  '使用管理員建立的帳號繼續。首次登入時需要設定新密碼。',
                  'Continue with an administrator-provisioned account. You will set a new password on first sign-in.',
                )}
              </Typography.Paragraph>
            </div>
            <Button
              className="login-submit"
              type="primary"
              size="large"
              block
              href={loginHref(returnTo, locale)}
              icon={<ArrowRightOutlined />}
              iconPosition="end"
            >
              {tr('使用單一登入繼續', 'Continue with single sign-on')}
            </Button>
            <div className="login-security-note">
              <Typography.Text type="secondary">
                {tr(
                  '登入由獨立身分服務安全處理；控制台不會接觸您的密碼。',
                  'Authentication is handled by the identity service; this console never sees your password.',
                )}
              </Typography.Text>
            </div>
          </div>
        </Card>
      </section>
    </main>
  );
}
