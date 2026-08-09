import { ApiReferenceReact } from '@scalar/api-reference-react';
import { BookOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, Space, Typography } from 'antd';

import { endpoints } from '@/api/endpoints';
import { PageIntro } from '@/components/PageIntro';
import { useAppSettings } from '@/context/AppSettings';

const docsTryItRoutes: Record<string, string> = {
  'POST /v1/chat/completions': '/api/me/docs-test/chat',
  'POST /v1/responses': '/api/me/docs-test/responses',
  'POST /v1/embeddings': '/api/me/docs-test/embeddings',
  'GET /v1/models': '/api/me/docs-test/models',
};

async function authenticatedDocsFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== window.location.origin) return fetch(request);

  const modelPrefix = '/v1/models/';
  const directRoute = docsTryItRoutes[`${request.method.toUpperCase()} ${url.pathname}`];
  const modelRoute =
    request.method.toUpperCase() === 'GET' && url.pathname.startsWith(modelPrefix)
      ? `/api/me/docs-test/models/${encodeURIComponent(decodeURIComponent(url.pathname.slice(modelPrefix.length)))}`
      : undefined;
  const route = directRoute ?? modelRoute;
  if (!route) return fetch(request);

  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set('X-Requested-With', 'SpiderwebRouterDocs');
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.clone().arrayBuffer();
  return fetch(`${route}${url.search}`, {
    method: request.method,
    headers,
    body,
    credentials: 'include',
    signal: request.signal,
  });
}

export function DocsPage() {
  const { colorMode, tr } = useAppSettings();
  const configuration = {
    url: `/api${endpoints.openapi}`,
    theme: colorMode === 'dark' ? 'saturn' : 'default',
    layout: 'modern',
    showSidebar: true,
    hideModels: false,
    hideDownloadButton: false,
    hideTestRequestButton: false,
    isEditable: false,
    persistAuth: false,
    fetch: authenticatedDocsFetch,
    defaultHttpClient: { targetKey: 'js', clientKey: 'fetch' },
    metaData: {
      title: 'SpiderwebRouter API Reference',
      description: 'OpenAI-compatible Chat Completions, Responses, and Embeddings API',
    },
  };

  return (
    <>
      <PageIntro
        eyebrow={tr('開發者控制台', 'Developer console')}
        title={tr('API 文件與測試', 'API reference and testing')}
        description={tr(
          '完整的 OpenAPI 規格、範例與登入後 Try It。測試請求會使用你的帳號授權並照常統計。',
          'Explore the OpenAPI specification, examples, and authenticated Try It. Test requests use your grants and are metered normally.',
        )}
      />
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message={tr('Try It 使用控制台 Session', 'Try It uses your console session')}
        description={tr(
          '文件測試不需要貼上 API Key，也不會在瀏覽器保存憑證；正式整合仍應使用 Authorization: Bearer sk-swr-…。',
          'Documentation tests do not require pasting an API key and store no credentials in the browser. Production integrations still use Authorization: Bearer sk-swr-….',
        )}
        className="docs-notice"
      />
      <section className="scalar-shell" aria-label={tr('API 文件', 'API reference')}>
        <div className="scalar-shell__title">
          <Space>
            <BookOutlined />
            <Typography.Text strong>SpiderwebRouter OpenAPI</Typography.Text>
          </Space>
        </div>
        <ApiReferenceReact configuration={configuration as never} />
      </section>
    </>
  );
}
