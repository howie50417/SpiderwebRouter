import {
  CodeOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  Upload,
  type UploadFile,
} from 'antd';
import type { ThinkingLevel } from '@spiderwebrouter/contracts';
import { useEffect, useMemo, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { useApiResource } from '@/api/hooks';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/AsyncState';
import { PageIntro } from '@/components/PageIntro';
import { useAppSettings } from '@/context/AppSettings';
import { playgroundModelControls } from '@/lib/playgroundRequest';
import type { ModelOption } from '@/types';

type PlaygroundMode = 'chat' | 'responses' | 'embeddings';

interface PlaygroundFormValues {
  model: string;
  prompt: string;
  stream?: boolean;
  temperature?: number;
  dimensions?: number;
  toolsJson?: string;
  reasoningEffort?: ThinkingLevel;
}

interface PlaygroundResult {
  response: unknown;
  elapsedMs: number;
  requestId?: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });
}

export function PlaygroundPage() {
  const [form] = Form.useForm<PlaygroundFormValues>();
  const { message } = App.useApp();
  const { tr } = useAppSettings();
  const [mode, setMode] = useState<PlaygroundMode>('chat');
  const [imageData, setImageData] = useState<string>();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PlaygroundResult>();
  const [error, setError] = useState<ReturnType<typeof getSafeError>>();
  const models = useApiResource(
    (signal) =>
      apiClient
        .list<ModelOption>(endpoints.myModels, { pageSize: 500 })
        .then((value) => value.data),
    [],
  );
  const selectedModelId = Form.useWatch('model', form);
  const selectedModel = useMemo(
    () => models.data?.find((item) => item.id === selectedModelId || item.name === selectedModelId),
    [models.data, selectedModelId],
  );
  const availableModels = (models.data ?? []).filter((model) =>
    mode === 'embeddings'
      ? model.capabilities.embeddings
      : mode === 'responses'
        ? model.capabilities.responses
        : model.capabilities.chat,
  );
  const temperatureUnsupported = selectedModel?.parameterSupport.temperature === false;
  const userSelectableThinking =
    selectedModel?.thinkingControlMode === 'USER_SELECTABLE' &&
    selectedModel.supportedThinkingLevels.length > 0;

  useEffect(() => {
    form.setFieldValue('reasoningEffort', undefined);
    if (temperatureUnsupported) form.setFieldValue('temperature', undefined);
  }, [form, selectedModel?.id, temperatureUnsupported]);

  const resetResult = () => {
    setResult(undefined);
    setError(undefined);
  };

  const handleModeChange = (value: PlaygroundMode) => {
    setMode(value);
    form.setFieldValue('model', undefined);
    setImageData(undefined);
    setFileList([]);
    resetResult();
  };

  const submit = async (values: PlaygroundFormValues) => {
    setSubmitting(true);
    resetResult();
    const startedAt = performance.now();
    try {
      let tools: unknown;
      if (values.toolsJson?.trim()) {
        try {
          tools = JSON.parse(values.toolsJson);
        } catch {
          message.error(tr('Tools JSON 格式不正確', 'Tools JSON is invalid'));
          return;
        }
      }

      let endpoint: string;
      let payload: Record<string, unknown>;
      const modelControls = playgroundModelControls(
        mode,
        selectedModel,
        values.temperature,
        values.reasoningEffort,
      );
      if (mode === 'chat') {
        endpoint = endpoints.playgroundChat;
        payload = {
          model: values.model,
          messages: [
            {
              role: 'user',
              content: imageData
                ? [
                    { type: 'text', text: values.prompt },
                    { type: 'image_url', image_url: { url: imageData } },
                  ]
                : values.prompt,
            },
          ],
          stream: Boolean(values.stream),
          ...modelControls,
          tools,
        };
      } else if (mode === 'responses') {
        endpoint = endpoints.playgroundResponses;
        payload = {
          model: values.model,
          input: imageData
            ? [
                {
                  role: 'user',
                  content: [
                    { type: 'input_text', text: values.prompt },
                    { type: 'input_image', image_url: imageData },
                  ],
                },
              ]
            : values.prompt,
          stream: Boolean(values.stream),
          ...modelControls,
          tools,
        };
      } else {
        endpoint = endpoints.playgroundEmbeddings;
        payload = {
          model: values.model,
          input: values.prompt,
          dimensions: values.dimensions,
        };
      }

      const response = await apiClient.post<unknown>(endpoint, payload);
      const record =
        response && typeof response === 'object'
          ? (response as Record<string, unknown>)
          : undefined;
      setResult({
        response,
        elapsedMs: performance.now() - startedAt,
        requestId: typeof record?.request_id === 'string' ? record.request_id : undefined,
      });
    } catch (reason) {
      setError(getSafeError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (models.loading && !models.data) return <PageSkeleton />;

  return (
    <>
      <PageIntro
        eyebrow={tr('開發者控制台', 'Developer console')}
        title="Playground"
        description={tr(
          '用目前帳號授權的模型測試 Chat Completions、Responses 與 Embeddings。所有請求都會照常計量與計價。',
          'Test Chat Completions, Responses, and Embeddings with your granted models. Every request is metered and priced normally.',
        )}
      />

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message={tr('內容不會儲存', 'Content is not retained')}
        description={tr(
          '本頁只在目前瀏覽器記憶體顯示輸入與結果；伺服器只保留去識別化用量與診斷中繼資料。',
          'Inputs and results remain in this browser session. The server retains only metering and redacted diagnostic metadata.',
        )}
        className="playground-notice"
      />

      {models.error ? <ErrorState compact error={models.error} onRetry={models.refresh} /> : null}

      <div className="playground-grid">
        <Card className="playground-composer">
          <Segmented<PlaygroundMode>
            block
            value={mode}
            onChange={handleModeChange}
            options={[
              { value: 'chat', label: 'Chat' },
              { value: 'responses', label: 'Responses' },
              { value: 'embeddings', label: 'Embeddings' },
            ]}
          />
          <Form<PlaygroundFormValues>
            form={form}
            layout="vertical"
            initialValues={{ stream: false, temperature: 0.7 }}
            onFinish={(values) => void submit(values)}
            className="playground-form"
          >
            <Form.Item name="model" label={tr('模型', 'Model')} rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={
                  availableModels.length
                    ? tr('選擇已授權模型', 'Select a granted model')
                    : tr('沒有支援此介面的模型', 'No model supports this API')
                }
                options={availableModels.map((model) => ({ label: model.name, value: model.name }))}
              />
            </Form.Item>
            <Form.Item
              name="prompt"
              label={mode === 'embeddings' ? tr('輸入文字', 'Input text') : tr('訊息', 'Message')}
              rules={[{ required: true }, { max: 100_000 }]}
            >
              <Input.TextArea
                rows={mode === 'embeddings' ? 8 : 12}
                showCount
                placeholder={
                  mode === 'embeddings'
                    ? tr('輸入要向量化的文字…', 'Enter text to embed…')
                    : tr('輸入訊息…', 'Enter a message…')
                }
              />
            </Form.Item>

            {mode !== 'embeddings' ? (
              <div className="playground-upload-row">
                <Upload
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  maxCount={1}
                  fileList={fileList}
                  listType="picture"
                  beforeUpload={async (file) => {
                    if (!file.type.startsWith('image/')) {
                      message.error(tr('只能上傳圖片', 'Only image files are supported'));
                      return Upload.LIST_IGNORE;
                    }
                    if (file.size > 10 * 1024 * 1024) {
                      message.error(tr('圖片不可超過 10 MiB', 'Images must be 10 MiB or smaller'));
                      return Upload.LIST_IGNORE;
                    }
                    if (selectedModel && !selectedModel.capabilities.vision) {
                      message.error(
                        tr('此模型未啟用圖片能力', 'Vision is not enabled for this model'),
                      );
                      return Upload.LIST_IGNORE;
                    }
                    try {
                      setImageData(await readAsDataUrl(file));
                      setFileList([
                        { uid: file.uid, name: file.name, status: 'done', originFileObj: file },
                      ]);
                    } catch {
                      message.error(tr('無法讀取圖片', 'Unable to read the image'));
                    }
                    return false;
                  }}
                  onRemove={() => {
                    setImageData(undefined);
                    setFileList([]);
                  }}
                >
                  <Button
                    icon={<PictureOutlined />}
                    disabled={Boolean(selectedModel && !selectedModel.capabilities.vision)}
                  >
                    {tr('加入圖片', 'Add image')}
                  </Button>
                </Upload>
              </div>
            ) : null}

            <Collapse
              ghost
              items={[
                {
                  key: 'advanced',
                  label: tr('進階參數', 'Advanced parameters'),
                  children: (
                    <>
                      {mode !== 'embeddings' ? (
                        <>
                          <Form.Item
                            name="temperature"
                            label="Temperature"
                            extra={
                              temperatureUnsupported
                                ? tr(
                                    '此模型不支援 Temperature；Router 也會在伺服器端移除此參數。',
                                    'This model does not support Temperature. The Router also removes it server-side.',
                                  )
                                : undefined
                            }
                          >
                            <InputNumber
                              min={0}
                              max={2}
                              step={0.1}
                              className="full-width"
                              disabled={temperatureUnsupported}
                            />
                          </Form.Item>
                          <Form.Item
                            name="stream"
                            label={tr('串流', 'Streaming')}
                            valuePropName="checked"
                          >
                            <Switch />
                          </Form.Item>
                          {userSelectableThinking ? (
                            <Form.Item
                              name="reasoningEffort"
                              label={tr('Thinking 強度', 'Thinking effort')}
                              extra={tr(
                                '留空會使用 Provider 預設；只能選擇管理員已確認的檔位。',
                                'Leave blank to use the provider default. Only administrator-confirmed levels are available.',
                              )}
                            >
                              <Select
                                allowClear
                                placeholder={tr('Provider 預設', 'Provider default')}
                                options={selectedModel.supportedThinkingLevels.map((level) => ({
                                  value: level,
                                  label: level,
                                }))}
                              />
                            </Form.Item>
                          ) : null}
                          <Form.Item
                            name="toolsJson"
                            label="Tools JSON"
                            extra={tr(
                              userSelectableThinking
                                ? '此模型已開放使用者自行設定 Thinking。'
                                : 'Thinking 強度由管理員固定，無法在此覆寫。',
                              userSelectableThinking
                                ? 'This model allows users to choose a Thinking level.'
                                : 'Thinking level is fixed by the administrator and cannot be overridden here.',
                            )}
                          >
                            <Input.TextArea
                              rows={5}
                              placeholder='[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]'
                            />
                          </Form.Item>
                        </>
                      ) : (
                        <Form.Item name="dimensions" label="Dimensions">
                          <InputNumber min={1} max={65_536} precision={0} className="full-width" />
                        </Form.Item>
                      )}
                    </>
                  ),
                },
              ]}
            />
            <Button
              type="primary"
              size="large"
              block
              htmlType="submit"
              icon={<PlayCircleOutlined />}
              loading={submitting}
              disabled={!availableModels.length}
            >
              {submitting ? tr('模型處理中…', 'Running…') : tr('送出測試', 'Run request')}
            </Button>
          </Form>
        </Card>

        <Card
          className="playground-output"
          title={
            <Space>
              <ExperimentOutlined /> {tr('回應', 'Response')}
            </Space>
          }
          extra={
            result ? (
              <Button type="text" icon={<DeleteOutlined />} onClick={resetResult}>
                {tr('清除', 'Clear')}
              </Button>
            ) : null
          }
        >
          {error ? (
            <ErrorState compact error={error} onRetry={() => form.submit()} />
          ) : result ? (
            <Space direction="vertical" size={16} className="full-width">
              <Descriptions
                size="small"
                column={2}
                items={[
                  {
                    key: 'elapsed',
                    label: tr('瀏覽器耗時', 'Browser elapsed'),
                    children: `${result.elapsedMs.toFixed(0)} ms`,
                  },
                  {
                    key: 'request',
                    label: tr('追蹤編號', 'Request ID'),
                    children: result.requestId ? (
                      <Typography.Text copyable>{result.requestId}</Typography.Text>
                    ) : (
                      '—'
                    ),
                  },
                ]}
              />
              <pre className="code-panel playground-code">
                {typeof result.response === 'string'
                  ? result.response
                  : JSON.stringify(result.response, null, 2)}
              </pre>
            </Space>
          ) : (
            <EmptyState
              title={tr('準備好開始測試', 'Ready to test')}
              description={tr(
                '選擇模型並送出訊息，回應會顯示在這裡。',
                'Choose a model and submit a message to see the response here.',
              )}
              action={<Tag icon={<CodeOutlined />}>{mode}</Tag>}
            />
          )}
        </Card>
      </div>
    </>
  );
}
