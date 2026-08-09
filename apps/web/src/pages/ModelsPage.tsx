import {
  CheckOutlined,
  EditOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  DrawerForm,
  ProFormCheckbox,
  ProFormDependency,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
  type ActionType,
  type ProColumns,
} from '@ant-design/pro-components';
import {
  promptModes,
  thinkingLevels,
  type ModelCapabilities,
  type PromptMode,
  type ThinkingLevel,
} from '@spiderwebrouter/contracts';
import { App, Button, Popconfirm, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { type Key, useRef, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { useApiResource } from '@/api/hooks';
import { ErrorState } from '@/components/AsyncState';
import { PageIntro } from '@/components/PageIntro';
import { EnabledBadge } from '@/components/StatusBadge';
import { useAppSettings } from '@/context/AppSettings';
import { formatDateTime, formatUsd } from '@/lib/format';
import type { DiscoveredModel, ProviderRecord, PublishedModel } from '@/types';

const capabilityKeys: (keyof ModelCapabilities)[] = [
  'chat',
  'responses',
  'embeddings',
  'vision',
  'tools',
  'structuredOutput',
  'streaming',
  'reasoning',
];

interface ModelFormValues {
  providerId: string;
  upstreamModelId: string;
  publicName: string;
  enabled: boolean;
  capabilities: (keyof ModelCapabilities)[];
  promptMode: PromptMode;
  systemPrompt?: string;
  thinkingLevel: ThinkingLevel;
  maxRetries: number;
  inputPriceUsdPerMillion: number;
  outputPriceUsdPerMillion: number;
}

function capabilitiesToList(value: Partial<ModelCapabilities>): (keyof ModelCapabilities)[] {
  return capabilityKeys.filter((key) => value[key] === true);
}

function listToCapabilities(value: (keyof ModelCapabilities)[]): ModelCapabilities {
  return Object.fromEntries(
    capabilityKeys.map((key) => [key, value.includes(key)]),
  ) as unknown as ModelCapabilities;
}

function CapabilityTags({ capabilities }: { capabilities: Partial<ModelCapabilities> }) {
  const enabled = capabilityKeys.filter((key) => capabilities[key]);
  return (
    <Space size={[2, 4]} wrap>
      {enabled.length ? (
        enabled.map((key) => <Tag key={key}>{key}</Tag>)
      ) : (
        <Typography.Text type="secondary">—</Typography.Text>
      )}
    </Space>
  );
}

export function ModelsPage() {
  const publishedRef = useRef<ActionType | undefined>(undefined);
  const candidatesRef = useRef<ActionType | undefined>(undefined);
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [activeTab, setActiveTab] = useState('published');
  const [editing, setEditing] = useState<PublishedModel>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<Key[]>([]);
  const [selectedCandidateRows, setSelectedCandidateRows] = useState<DiscoveredModel[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const providers = useApiResource(
    (signal) =>
      apiClient
        .list<ProviderRecord>(endpoints.providers, { pageSize: 200, enabled: true })
        .then((result) => result.data),
    [],
  );

  const notifyError = (reason: unknown) => {
    const error = getSafeError(reason);
    message.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`);
  };

  const scanAll = async () => {
    setScanning(true);
    try {
      const activeProviders = (providers.data ?? []).filter((provider) => provider.enabled);
      const results = await Promise.allSettled(
        activeProviders.map((provider) => apiClient.post(endpoints.providerScan(provider.id))),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      message.success(tr('模型掃描已排入工作佇列', 'Model scan has been queued'));
      setActiveTab('candidates');
      window.setTimeout(() => candidatesRef.current?.reload(), 800);
    } catch (error) {
      notifyError(error);
    } finally {
      setScanning(false);
    }
  };

  const publishSelected = async () => {
    if (!selectedCandidates.length) return;
    setPublishing(true);
    try {
      for (const candidate of selectedCandidateRows) {
        await apiClient.post(endpoints.publishedModels, {
          providerId: candidate.providerId,
          upstreamModelId: candidate.upstreamModelId,
          publicName: candidate.upstreamModelId,
          enabled: false,
          capabilities: listToCapabilities(capabilitiesToList(candidate.capabilities)),
          promptMode: 'NONE',
          systemPrompt: null,
          thinkingLevel: 'PROVIDER_DEFAULT',
          maxRetries: 0,
          inputPriceUsdPerMillion: '0',
          outputPriceUsdPerMillion: '0',
        });
      }
      message.success(
        tr(
          '已加入模型目錄；發布前請逐一確認名稱、能力與價格。',
          'Models were added to the catalog. Review names, capabilities, and pricing before enabling them.',
        ),
      );
      setSelectedCandidates([]);
      setSelectedCandidateRows([]);
      candidatesRef.current?.reload();
      publishedRef.current?.reload();
      setActiveTab('published');
    } catch (error) {
      notifyError(error);
    } finally {
      setPublishing(false);
    }
  };

  const toggleModel = async (model: PublishedModel) => {
    try {
      await apiClient.patch(endpoints.publishedModel(model.id), { enabled: !model.enabled });
      message.success(
        model.enabled ? tr('模型已停用', 'Model disabled') : tr('模型已啟用', 'Model enabled'),
      );
      publishedRef.current?.reload();
    } catch (error) {
      notifyError(error);
    }
  };

  const publishedColumns: ProColumns<PublishedModel>[] = [
    {
      title: tr('公開名稱', 'Public name'),
      dataIndex: 'publicName',
      copyable: true,
      fixed: 'left',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong code>
            {row.publicName}
          </Typography.Text>
          <Typography.Text type="secondary">{row.providerName}</Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('上游模型', 'Upstream model'),
      dataIndex: 'upstreamModelId',
      ellipsis: true,
      copyable: true,
    },
    {
      title: tr('能力', 'Capabilities'),
      dataIndex: 'capabilities',
      search: false,
      width: 280,
      render: (_, row) => <CapabilityTags capabilities={row.capabilities} />,
    },
    {
      title: tr('提示詞', 'Prompt mode'),
      dataIndex: 'promptMode',
      valueType: 'select',
      valueEnum: Object.fromEntries(promptModes.map((mode) => [mode, mode])),
      width: 120,
    },
    {
      title: 'Thinking',
      dataIndex: 'thinkingLevel',
      valueType: 'select',
      valueEnum: Object.fromEntries(thinkingLevels.map((level) => [level, level])),
      width: 150,
    },
    {
      title: 'Retry',
      dataIndex: 'maxRetries',
      search: false,
      width: 85,
      renderText: (value) => `${value}×`,
    },
    {
      title: tr('價格 / 1M', 'Price / 1M'),
      search: false,
      width: 170,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>
            {tr('輸入', 'In')}: {formatUsd(row.inputPriceUsdPerMillion, locale)}
          </Typography.Text>
          <Typography.Text>
            {tr('輸出', 'Out')}: {formatUsd(row.outputPriceUsdPerMillion, locale)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('授權數', 'Grants'),
      dataIndex: 'grantCount',
      search: false,
      width: 90,
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'enabled',
      valueType: 'select',
      valueEnum: {
        true: { text: tr('啟用', 'Enabled') },
        false: { text: tr('停用', 'Disabled') },
      },
      width: 100,
      render: (_, row) => <EnabledBadge enabled={row.enabled} />,
    },
    {
      title: tr('操作', 'Actions'),
      valueType: 'option',
      fixed: 'right',
      width: 170,
      render: (_, row) => [
        <Button
          key="edit"
          type="link"
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setEditing(row);
            setDrawerOpen(true);
          }}
        >
          {tr('設定', 'Configure')}
        </Button>,
        <Popconfirm
          key="toggle"
          title={
            row.enabled
              ? tr('停用這個模型？', 'Disable this model?')
              : tr('啟用這個模型？', 'Enable this model?')
          }
          onConfirm={() => void toggleModel(row)}
        >
          <Button type="link" size="small" danger={row.enabled}>
            {row.enabled ? tr('停用', 'Disable') : tr('啟用', 'Enable')}
          </Button>
        </Popconfirm>,
      ],
    },
  ];

  const candidateColumns: ProColumns<DiscoveredModel>[] = [
    {
      title: tr('上游模型', 'Upstream model'),
      dataIndex: 'upstreamModelId',
      copyable: true,
      fixed: 'left',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong code>
            {row.upstreamModelId}
          </Typography.Text>
          <Typography.Text type="secondary">{row.providerName}</Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('偵測能力', 'Detected capabilities'),
      dataIndex: 'capabilities',
      search: false,
      render: (_, row) => <CapabilityTags capabilities={row.capabilities} />,
    },
    {
      title: tr('能力來源', 'Capability source'),
      dataIndex: 'capabilitySource',
      valueType: 'select',
      valueEnum: {
        METADATA: { text: tr('來源中繼資料', 'Provider metadata') },
        ADMIN_CONFIRMED: { text: tr('管理員確認', 'Admin confirmed') },
        UNKNOWN: { text: tr('未知', 'Unknown') },
      },
      width: 160,
    },
    {
      title: tr('最後發現', 'Last seen'),
      dataIndex: 'lastSeenAt',
      valueType: 'dateTime',
      search: false,
      width: 180,
      renderText: (value) => formatDateTime(value, locale),
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'published',
      search: false,
      width: 110,
      render: (_, row) =>
        row.published ? (
          <Tag color="success" icon={<CheckOutlined />}>
            {tr('已加入', 'Published')}
          </Tag>
        ) : (
          <Tag>{tr('候選', 'Candidate')}</Tag>
        ),
    },
  ];

  return (
    <>
      <PageIntro
        eyebrow={tr('超管', 'Administration')}
        title={tr('模型目錄', 'Model catalog')}
        description={tr(
          '掃描僅讀取模型中繼資料，不會發送可能計費的推理。候選模型必須由你選取、確認能力並發布。',
          'Scanning reads model metadata only and never sends billable inference. You choose, verify, and publish each candidate.',
        )}
        actions={
          <>
            <Button icon={<RadarChartOutlined />} loading={scanning} onClick={() => void scanAll()}>
              {tr('掃描全部來源', 'Scan all providers')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(undefined);
                setDrawerOpen(true);
              }}
            >
              {tr('建立自訂模型', 'Create custom model')}
            </Button>
          </>
        }
      />

      {providers.error ? (
        <ErrorState compact error={providers.error} onRetry={providers.refresh} />
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'published',
            label: tr('已發布模型', 'Published models'),
            children: (
              <ProTable<PublishedModel>
                actionRef={publishedRef}
                rowKey="id"
                columns={publishedColumns}
                cardBordered
                scroll={{ x: 1_500 }}
                search={{ labelWidth: 'auto', defaultCollapsed: false }}
                pagination={{ defaultPageSize: 20, showSizeChanger: true }}
                request={async (params) => {
                  try {
                    const result = await apiClient.list<PublishedModel>(endpoints.publishedModels, {
                      page: params.current,
                      pageSize: params.pageSize,
                      search: typeof params.publicName === 'string' ? params.publicName : undefined,
                      promptMode:
                        typeof params.promptMode === 'string' ? params.promptMode : undefined,
                      thinkingLevel:
                        typeof params.thinkingLevel === 'string' ? params.thinkingLevel : undefined,
                      enabled: typeof params.enabled === 'boolean' ? params.enabled : undefined,
                    });
                    return { ...result, success: true };
                  } catch (error) {
                    notifyError(error);
                    return { data: [], total: 0, success: false };
                  }
                }}
                toolBarRender={() => [
                  <Button
                    key="reload"
                    icon={<ReloadOutlined />}
                    onClick={() => publishedRef.current?.reload()}
                  >
                    {tr('重新整理', 'Refresh')}
                  </Button>,
                ]}
              />
            ),
          },
          {
            key: 'candidates',
            label: tr('掃描候選', 'Scan candidates'),
            children: (
              <ProTable<DiscoveredModel>
                actionRef={candidatesRef}
                rowKey="id"
                columns={candidateColumns}
                cardBordered
                scroll={{ x: 980 }}
                rowSelection={{
                  selectedRowKeys: selectedCandidates,
                  getCheckboxProps: (row) => ({ disabled: row.published }),
                  onChange: (keys, rows) => {
                    setSelectedCandidates(keys);
                    setSelectedCandidateRows(rows);
                  },
                }}
                tableAlertRender={({ selectedRowKeys }) => (
                  <Typography.Text>
                    {tr(
                      `已選擇 ${selectedRowKeys.length} 個模型`,
                      `${selectedRowKeys.length} models selected`,
                    )}
                  </Typography.Text>
                )}
                tableAlertOptionRender={() => (
                  <Button
                    type="primary"
                    size="small"
                    loading={publishing}
                    onClick={() => void publishSelected()}
                  >
                    {tr('加入模型目錄', 'Add to catalog')}
                  </Button>
                )}
                search={{ labelWidth: 'auto', defaultCollapsed: false }}
                pagination={{ defaultPageSize: 20, showSizeChanger: true }}
                request={async (params) => {
                  try {
                    const result = await apiClient.list<DiscoveredModel>(
                      endpoints.modelScanCandidates,
                      {
                        page: params.current,
                        pageSize: params.pageSize,
                        search:
                          typeof params.upstreamModelId === 'string'
                            ? params.upstreamModelId
                            : undefined,
                        capabilitySource:
                          typeof params.capabilitySource === 'string'
                            ? params.capabilitySource
                            : undefined,
                      },
                    );
                    return { ...result, success: true };
                  } catch (error) {
                    notifyError(error);
                    return { data: [], total: 0, success: false };
                  }
                }}
              />
            ),
          },
        ]}
      />

      <DrawerForm<ModelFormValues>
        key={editing?.id ?? 'new-model'}
        title={
          editing ? tr('設定模型', 'Configure model') : tr('建立自訂模型', 'Create custom model')
        }
        open={drawerOpen}
        drawerProps={{
          width: 620,
          destroyOnClose: true,
          onClose: () => setDrawerOpen(false),
        }}
        initialValues={
          editing
            ? {
                providerId: editing.providerId,
                upstreamModelId: editing.upstreamModelId,
                publicName: editing.publicName,
                enabled: editing.enabled,
                capabilities: capabilitiesToList(editing.capabilities),
                promptMode: editing.promptMode,
                systemPrompt: editing.systemPrompt ?? undefined,
                thinkingLevel: editing.thinkingLevel,
                maxRetries: editing.maxRetries,
                inputPriceUsdPerMillion: Number(editing.inputPriceUsdPerMillion),
                outputPriceUsdPerMillion: Number(editing.outputPriceUsdPerMillion),
              }
            : {
                enabled: false,
                capabilities: ['chat', 'streaming'],
                promptMode: 'NONE',
                thinkingLevel: 'PROVIDER_DEFAULT',
                maxRetries: 0,
                inputPriceUsdPerMillion: 0,
                outputPriceUsdPerMillion: 0,
              }
        }
        onFinish={async (values) => {
          try {
            const payload = {
              ...values,
              capabilities: listToCapabilities(values.capabilities ?? []),
              systemPrompt: values.promptMode === 'NONE' ? null : values.systemPrompt,
              inputPriceUsdPerMillion: String(values.inputPriceUsdPerMillion ?? 0),
              outputPriceUsdPerMillion: String(values.outputPriceUsdPerMillion ?? 0),
            };
            if (editing) {
              await apiClient.patch(endpoints.publishedModel(editing.id), payload);
            } else {
              await apiClient.post(endpoints.publishedModels, payload);
            }
            message.success(
              editing
                ? tr('模型設定已更新', 'Model settings updated')
                : tr('模型已建立', 'Model created'),
            );
            setDrawerOpen(false);
            publishedRef.current?.reload();
            return true;
          } catch (error) {
            notifyError(error);
            return false;
          }
        }}
      >
        <ProFormSelect
          name="providerId"
          label={tr('服務來源', 'Provider')}
          fieldProps={{ loading: providers.loading }}
          options={(providers.data ?? []).map((provider) => ({
            label: provider.name,
            value: provider.id,
          }))}
          disabled={Boolean(editing)}
          rules={[{ required: true }]}
        />
        <ProFormText
          name="upstreamModelId"
          label={tr('上游模型 ID', 'Upstream model ID')}
          placeholder="model-name"
          disabled={Boolean(editing)}
          rules={[{ required: true }, { max: 255 }]}
        />
        <ProFormText
          name="publicName"
          label={tr('全局公開名稱', 'Global public name')}
          placeholder="model-alias"
          tooltip={tr(
            '客戶只會看到此名稱或其專屬別名。',
            'Customers see only this name or their assigned alias.',
          )}
          rules={[
            { required: true },
            {
              pattern: /^[A-Za-z0-9._:-]+$/,
              message: tr(
                '只可使用英數、點、底線、冒號與連字號',
                'Use letters, numbers, dot, underscore, colon, or hyphen',
              ),
            },
          ]}
        />
        <ProFormCheckbox.Group
          name="capabilities"
          label={tr('已確認能力', 'Confirmed capabilities')}
          options={capabilityKeys.map((value) => ({ label: value, value }))}
        />
        <ProFormSelect
          name="promptMode"
          label="System prompt mode"
          options={promptModes.map((value) => ({ label: value, value }))}
          rules={[{ required: true }]}
        />
        <ProFormDependency name={['promptMode']}>
          {({ promptMode }) =>
            promptMode !== 'NONE' ? (
              <ProFormTextArea
                name="systemPrompt"
                label="System prompt"
                fieldProps={{ rows: 6, maxLength: 16_000, showCount: true }}
                rules={[{ required: true }]}
              />
            ) : null
          }
        </ProFormDependency>
        <ProFormSelect
          name="thinkingLevel"
          label={tr('伺服器 Thinking 強度', 'Server-controlled thinking')}
          options={thinkingLevels.map((value) => ({ label: value, value }))}
          tooltip={tr('此設定不會開放給客戶覆寫。', 'Customers cannot override this setting.')}
          rules={[{ required: true }]}
        />
        <ProFormDigit
          name="maxRetries"
          label={tr('Retry 次數', 'Retry count')}
          min={0}
          max={5}
          fieldProps={{ precision: 0 }}
          tooltip={tr(
            '不含首次請求；設定 2 代表最多共 3 次嘗試。串流開始輸出後不會 retry。',
            'Additional attempts after the first request. A value of 2 allows up to 3 attempts. Streaming is never retried after output begins.',
          )}
          rules={[{ required: true }]}
        />
        <div className="form-section-title">
          <SafetyCertificateOutlined />{' '}
          {tr('全局價格（USD / 1M tokens）', 'Global pricing (USD / 1M tokens)')}
        </div>
        <ProFormDigit
          name="inputPriceUsdPerMillion"
          label={tr('輸入價格', 'Input price')}
          min={0}
          max={1_000_000}
          fieldProps={{ precision: 6, prefix: '$' }}
          rules={[{ required: true }]}
        />
        <ProFormDigit
          name="outputPriceUsdPerMillion"
          label={tr('輸出價格', 'Output price')}
          min={0}
          max={1_000_000}
          fieldProps={{ precision: 6, prefix: '$' }}
          rules={[{ required: true }]}
        />
        <ProFormSwitch
          name="enabled"
          label={tr('立即啟用', 'Enable now')}
          tooltip={tr(
            '啟用不會自動授權任何使用者。',
            'Enabling never grants access to a user automatically.',
          )}
        />
      </DrawerForm>
    </>
  );
}
