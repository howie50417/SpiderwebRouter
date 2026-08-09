import {
  CheckOutlined,
  DeleteOutlined,
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
  type ProFormInstance,
} from '@ant-design/pro-components';
import {
  promptModes,
  thinkingLevels,
  type ModelCapabilities,
  type PromptMode,
  type ThinkingLevel,
} from '@spiderwebrouter/contracts';
import { Alert, App, Button, Popconfirm, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { type Key, useEffect, useRef, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { useApiResource } from '@/api/hooks';
import { ErrorState } from '@/components/AsyncState';
import { PageIntro } from '@/components/PageIntro';
import { EnabledBadge } from '@/components/StatusBadge';
import { useAppSettings } from '@/context/AppSettings';
import { formatDateTime, formatUsd } from '@/lib/format';
import { modelAliasPattern } from '@/lib/modelAlias';
import { pollModelScan, type ModelScanJob } from '@/lib/modelScan';
import {
  modelDeletionNotice,
  promptModePresentation,
  selectableThinkingLevels,
  type DeleteModelResult,
} from '@/lib/modelForm';
import type {
  DiscoveredModel,
  DiscoveredModelCapabilities,
  ProviderRecord,
  PublishedModel,
  PublishedModelCapabilities,
  ThinkingControlMode,
} from '@/types';

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
  thinkingControlMode: ThinkingControlMode;
  supportedThinkingLevels: ThinkingLevel[];
  maxRetries: number;
  inputPriceUsdPerMillion: number;
  outputPriceUsdPerMillion: number;
}

function capabilitiesToList(
  value: Partial<ModelCapabilities> | DiscoveredModelCapabilities,
): (keyof ModelCapabilities)[] {
  return capabilityKeys.filter((key) => value[key] === true);
}

function listToCapabilities(
  value: (keyof ModelCapabilities)[],
  nativeResponses = false,
): PublishedModelCapabilities {
  return {
    ...(Object.fromEntries(
      capabilityKeys.map((key) => [key, value.includes(key)]),
    ) as unknown as ModelCapabilities),
    ...(nativeResponses ? { nativeResponses: true } : {}),
  };
}

function CapabilityTags({ capabilities }: { capabilities: DiscoveredModelCapabilities }) {
  const { tr } = useAppSettings();
  const supported = capabilityKeys.filter((key) => capabilities[key] === true);
  const unconfirmed = capabilityKeys.filter(
    (key) => capabilities[key] === 'unconfirmed' || capabilities[key] === undefined,
  );
  const unsupported = capabilityKeys.filter((key) => capabilities[key] === false);
  return (
    <Space size={[2, 4]} wrap>
      {supported.map((key) => (
        <Tag color="green" key={key}>
          {key}
        </Tag>
      ))}
      {unconfirmed.map((key) => (
        <Tag color="gold" key={key}>
          {key} · {tr('待確認', 'unconfirmed')}
        </Tag>
      ))}
      {unsupported.length ? (
        <Tooltip title={unsupported.join(', ')}>
          <Tag>
            {tr('不支援', 'unsupported')} · {unsupported.length}
          </Tag>
        </Tooltip>
      ) : null}
    </Space>
  );
}

export function ModelsPage() {
  const publishedRef = useRef<ActionType | undefined>(undefined);
  const candidatesRef = useRef<ActionType | undefined>(undefined);
  const modelFormRef = useRef<ProFormInstance<ModelFormValues> | undefined>(undefined);
  const scanAbortRef = useRef<AbortController | undefined>(undefined);
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [activeTab, setActiveTab] = useState('published');
  const [editing, setEditing] = useState<PublishedModel>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<Key[]>([]);
  const [selectedCandidateRows, setSelectedCandidateRows] = useState<DiscoveredModel[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const providers = useApiResource(
    (signal) =>
      apiClient
        .list<ProviderRecord>(endpoints.providers, { pageSize: 200 })
        .then((result) => result.data),
    [],
  );

  useEffect(() => {
    const available = providers.data ?? [];
    if (!available.length) {
      setActiveProviderId(undefined);
      return;
    }
    if (activeProviderId && available.some((provider) => provider.id === activeProviderId)) return;
    setActiveProviderId(available.find((provider) => provider.enabled)?.id ?? available.at(0)?.id);
  }, [activeProviderId, providers.data]);

  useEffect(() => () => scanAbortRef.current?.abort(), []);

  const activeProvider = (providers.data ?? []).find(
    (provider) => provider.id === activeProviderId,
  );
  const discoveredModels = useApiResource(
    (signal) =>
      apiClient
        .list<DiscoveredModel>(endpoints.modelScanCandidates, { pageSize: 10_000 })
        .then((result) => result.data),
    [],
  );

  const notifyError = (reason: unknown) => {
    const error = getSafeError(reason);
    message.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`);
  };

  const scanProvider = async (provider: ProviderRecord) => {
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    setScanning(true);
    try {
      const queued = await apiClient.post<{ jobId: string }>(endpoints.providerScan(provider.id));
      setActiveTab('candidates');
      message.info(
        tr(`正在掃描來源「${provider.name}」…`, `Scanning provider “${provider.name}”…`),
      );
      const job = await pollModelScan({
        jobId: queued.jobId,
        load: (jobId) =>
          apiClient.get<ModelScanJob>(endpoints.modelScanJob(jobId), undefined, controller.signal),
      });
      if (job.status === 'FAILED') {
        message.error(
          tr(
            `來源「${provider.name}」掃描失敗，請使用追蹤日誌排查。`,
            `Scanning “${provider.name}” failed. Use the request logs to investigate.`,
          ),
        );
        return;
      }
      message.success(
        tr(
          `來源「${provider.name}」掃描完成，共發現 ${job.discoveredCount} 個模型。`,
          `Scanning “${provider.name}” completed with ${job.discoveredCount} models.`,
        ),
      );
      candidatesRef.current?.reload();
      discoveredModels.refresh();
      providers.refresh();
    } catch (error) {
      if (controller.signal.aborted) return;
      notifyError(error);
    } finally {
      if (scanAbortRef.current === controller) scanAbortRef.current = undefined;
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
          capabilities: listToCapabilities(
            capabilitiesToList(candidate.capabilities),
            candidate.capabilities.nativeResponses === true,
          ),
          promptMode: 'NONE',
          systemPrompt: null,
          thinkingLevel: 'PROVIDER_DEFAULT',
          thinkingControlMode: 'FIXED',
          supportedThinkingLevels: candidate.metadata.supportedThinkingLevels ?? [],
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
      discoveredModels.refresh();
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

  const deleteModel = async (model: PublishedModel) => {
    setDeletingId(model.id);
    try {
      const result = await apiClient.delete<DeleteModelResult>(endpoints.publishedModel(model.id));
      message.success(
        modelDeletionNotice(result) === 'HISTORY_PRESERVED'
          ? tr(
              '模型因已有使用歷史而封存，已從模型目錄隱藏；歷史統計仍會保留。',
              'The model had usage history, so it was archived and hidden while its history was preserved.',
            )
          : tr('模型已永久刪除', 'Model permanently deleted'),
      );
      if (editing?.id === model.id) {
        setEditing(undefined);
        setDrawerOpen(false);
      }
      publishedRef.current?.reload();
      candidatesRef.current?.reload();
      discoveredModels.refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      setDeletingId(undefined);
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
      title: tr('系統提示詞模式', 'System prompt mode'),
      dataIndex: 'promptMode',
      valueType: 'select',
      valueEnum: Object.fromEntries(
        promptModes.map((mode) => [
          mode,
          tr(promptModePresentation[mode].labelZh, promptModePresentation[mode].labelEn),
        ]),
      ),
      width: 145,
    },
    {
      title: 'Thinking',
      dataIndex: 'thinkingLevel',
      valueType: 'select',
      valueEnum: Object.fromEntries(thinkingLevels.map((level) => [level, level])),
      width: 150,
      render: (_, row) =>
        row.thinkingControlMode === 'USER_SELECTABLE' ? (
          <Space direction="vertical" size={0}>
            <Tag color="blue">{tr('使用者自行設定', 'User selectable')}</Tag>
            <Typography.Text type="secondary">
              {row.supportedThinkingLevels.join(', ') || '—'}
            </Typography.Text>
          </Space>
        ) : (
          <Tag>{tr(`伺服器固定 ${row.thinkingLevel}`, `Server fixed ${row.thinkingLevel}`)}</Tag>
        ),
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
      width: 245,
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
        <Popconfirm
          key="delete"
          title={tr('刪除這個模型？', 'Delete this model?')}
          description={tr(
            '模型會立即從目錄及客戶端隱藏。若已有使用歷史，系統將改為封存並保留統計資料。',
            'The model will immediately be hidden from the catalog and customers. Models with usage history are archived so statistics remain intact.',
          )}
          okText={tr('刪除', 'Delete')}
          cancelText={tr('取消', 'Cancel')}
          okButtonProps={{ danger: true, loading: deletingId === row.id }}
          onConfirm={() => deleteModel(row)}
        >
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={deletingId === row.id}
          >
            {tr('刪除', 'Delete')}
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
        PROVIDER_STATUS: { text: tr('來源執行狀態', 'Provider runtime status') },
        ROUTER_EMULATION: { text: tr('Router 轉接能力', 'Router emulation') },
        OFFICIAL_CATALOG: { text: tr('OpenAI 官方目錄', 'OpenAI official catalog') },
        MIXED: { text: tr('多種來源', 'Mixed evidence') },
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
      render: (_, row) => formatDateTime(row.lastSeenAt, locale),
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
          '掃描只讀取模型中繼資料，不會發送可能計費的推理。綠色能力會自動預選，黃色問號代表來源未提供足夠證據，發布前仍需由你確認。',
          'Scanning reads model metadata only and never sends billable inference. Green capabilities are preselected; a yellow question mark means the provider did not supply enough evidence and needs your review.',
        )}
        actions={
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
              <>
                <Tabs
                  type="card"
                  activeKey={activeProviderId}
                  onChange={(providerId) => {
                    setActiveProviderId(providerId);
                    setSelectedCandidates([]);
                    setSelectedCandidateRows([]);
                  }}
                  items={(providers.data ?? []).map((provider) => ({
                    key: provider.id,
                    label: (
                      <Space size={6}>
                        {provider.name}
                        {!provider.enabled ? <Tag>{tr('停用', 'Disabled')}</Tag> : null}
                      </Space>
                    ),
                  }))}
                  tabBarExtraContent={
                    activeProvider ? (
                      <Tooltip
                        title={
                          activeProvider.enabled
                            ? undefined
                            : tr('請先啟用此服務來源', 'Enable this provider before scanning')
                        }
                      >
                        <Button
                          icon={<RadarChartOutlined />}
                          loading={scanning}
                          disabled={!activeProvider.enabled}
                          onClick={() => void scanProvider(activeProvider)}
                        >
                          {tr(
                            `掃描此來源：${activeProvider.name}`,
                            `Scan this provider: ${activeProvider.name}`,
                          )}
                        </Button>
                      </Tooltip>
                    ) : null
                  }
                />
                {activeProvider ? (
                  <ProTable<DiscoveredModel>
                    key={activeProvider.id}
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
                            providerId: activeProvider.id,
                            available: true,
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
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    message={tr(
                      '請先建立服務來源，才能掃描模型。',
                      'Create a provider before scanning models.',
                    )}
                  />
                )}
              </>
            ),
          },
        ]}
      />

      <DrawerForm<ModelFormValues>
        key={editing?.id ?? 'new-model'}
        formRef={modelFormRef}
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
                thinkingControlMode: editing.thinkingControlMode,
                supportedThinkingLevels: editing.supportedThinkingLevels,
                maxRetries: editing.maxRetries,
                inputPriceUsdPerMillion: Number(editing.inputPriceUsdPerMillion),
                outputPriceUsdPerMillion: Number(editing.outputPriceUsdPerMillion),
              }
            : {
                enabled: false,
                capabilities: ['chat', 'streaming'],
                promptMode: 'NONE',
                thinkingLevel: 'PROVIDER_DEFAULT',
                thinkingControlMode: 'FIXED',
                supportedThinkingLevels: [],
                maxRetries: 0,
                inputPriceUsdPerMillion: 0,
                outputPriceUsdPerMillion: 0,
              }
        }
        onFinish={async (values) => {
          try {
            const discovered = (discoveredModels.data ?? []).find(
              (candidate) =>
                candidate.providerId === values.providerId &&
                candidate.upstreamModelId === values.upstreamModelId,
            );
            const supportedThinkingLevels = editing
              ? (values.supportedThinkingLevels ?? editing.supportedThinkingLevels)
              : (values.supportedThinkingLevels ??
                discovered?.metadata.supportedThinkingLevels ??
                []);
            const payload = {
              ...values,
              capabilities: listToCapabilities(
                values.capabilities ?? [],
                editing?.capabilities.nativeResponses === true,
              ),
              systemPrompt: values.promptMode === 'NONE' ? null : values.systemPrompt,
              thinkingLevel:
                values.thinkingControlMode === 'FIXED' ? values.thinkingLevel : 'PROVIDER_DEFAULT',
              supportedThinkingLevels,
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
          fieldProps={{
            loading: providers.loading,
            onChange: () => {
              modelFormRef.current?.setFieldValue('supportedThinkingLevels', []);
              modelFormRef.current?.setFieldValue('thinkingLevel', 'PROVIDER_DEFAULT');
              modelFormRef.current?.setFieldValue('thinkingControlMode', 'FIXED');
            },
          }}
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
          fieldProps={{
            onChange: () => {
              modelFormRef.current?.setFieldValue('supportedThinkingLevels', []);
              modelFormRef.current?.setFieldValue('thinkingLevel', 'PROVIDER_DEFAULT');
              modelFormRef.current?.setFieldValue('thinkingControlMode', 'FIXED');
            },
          }}
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
              pattern: modelAliasPattern,
              message: tr(
                '只可使用英數、點、底線、冒號、斜線與連字號',
                'Use letters, numbers, dot, underscore, colon, slash, or hyphen',
              ),
            },
          ]}
        />
        <ProFormDependency name={['providerId', 'upstreamModelId']}>
          {({ providerId, upstreamModelId }) => {
            const discovered = (discoveredModels.data ?? []).find(
              (candidate) =>
                candidate.providerId === providerId &&
                candidate.upstreamModelId === upstreamModelId,
            );
            const confirmedCapabilities = discovered
              ? capabilitiesToList(discovered.capabilities)
              : [];
            return (
              <>
                <ProFormCheckbox.Group
                  name="capabilities"
                  label={tr('已確認能力', 'Confirmed capabilities')}
                  options={capabilityKeys.map((value) => {
                    const state = discovered?.capabilities[value];
                    return {
                      value,
                      label: discovered
                        ? state === true
                          ? tr(`${value}（來源確認）`, `${value} (provider-confirmed)`)
                          : state === false
                            ? tr(`${value}（來源不支援）`, `${value} (provider-unsupported)`)
                            : tr(`${value}（待確認）`, `${value} (unconfirmed)`)
                        : value,
                    };
                  })}
                />
                {confirmedCapabilities.length ? (
                  <Button
                    size="small"
                    style={{ marginBottom: 16 }}
                    onClick={() => {
                      const fieldValue = modelFormRef.current?.getFieldValue('capabilities');
                      const current = Array.isArray(fieldValue) ? fieldValue : [];
                      modelFormRef.current?.setFieldValue('capabilities', [
                        ...new Set([...current, ...confirmedCapabilities]),
                      ]);
                    }}
                  >
                    {tr('套用來源已確認能力', 'Apply provider-confirmed capabilities')}
                  </Button>
                ) : null}
              </>
            );
          }}
        </ProFormDependency>
        <ProFormSelect
          name="promptMode"
          label={tr('系統提示詞模式', 'System prompt mode')}
          options={promptModes.map((value) => ({
            label: tr(
              `${promptModePresentation[value].labelZh}（${value}）`,
              `${promptModePresentation[value].labelEn} (${value})`,
            ),
            value,
          }))}
          tooltip={
            <Space direction="vertical" size={4}>
              {promptModes.map((mode) => (
                <span key={mode}>
                  <Typography.Text strong style={{ color: 'inherit' }}>
                    {tr(promptModePresentation[mode].labelZh, promptModePresentation[mode].labelEn)}
                  </Typography.Text>
                  {tr(
                    `：${promptModePresentation[mode].descriptionZh}`,
                    `: ${promptModePresentation[mode].descriptionEn}`,
                  )}
                </span>
              ))}
            </Space>
          }
          rules={[{ required: true }]}
        />
        <ProFormDependency name={['promptMode']}>
          {({ promptMode }) =>
            promptMode !== 'NONE' ? (
              <ProFormTextArea
                name="systemPrompt"
                label={tr('系統提示詞', 'System prompt')}
                fieldProps={{ rows: 6, maxLength: 16_000, showCount: true }}
                rules={[{ required: true }]}
              />
            ) : null
          }
        </ProFormDependency>
        <ProFormSelect
          name="supportedThinkingLevels"
          hidden
          fieldProps={{ mode: 'multiple' }}
          options={thinkingLevels
            .filter((level) => level !== 'PROVIDER_DEFAULT')
            .map((value) => ({ value, label: value }))}
        />
        <ProFormDependency name={['providerId', 'upstreamModelId', 'supportedThinkingLevels']}>
          {({ providerId, upstreamModelId, supportedThinkingLevels }) => {
            const discovered = (discoveredModels.data ?? []).find(
              (candidate) =>
                candidate.providerId === providerId &&
                candidate.upstreamModelId === upstreamModelId,
            );
            const currentLevels = Array.isArray(supportedThinkingLevels)
              ? (supportedThinkingLevels as ThinkingLevel[])
              : [];
            const candidateLevels = discovered?.metadata.supportedThinkingLevels ?? [];
            const confirmed = new Set(currentLevels);
            const hasConfirmedLevels = confirmed.size > 0;
            const selectableLevels = selectableThinkingLevels([...confirmed]);
            return (
              <>
                <ProFormSelect
                  name="thinkingControlMode"
                  label={tr('Thinking 控制方式', 'Thinking control')}
                  options={[
                    {
                      value: 'FIXED',
                      label: tr('伺服器固定', 'Server fixed'),
                    },
                    {
                      value: 'USER_SELECTABLE',
                      label: tr('開放使用者自行設定', 'User selectable'),
                      disabled: !hasConfirmedLevels,
                    },
                  ]}
                  tooltip={tr(
                    '固定模式會移除客戶的 Thinking 設定；開放模式只接受來源或官方目錄已確認的檔位。',
                    'Fixed mode removes client thinking settings. User-selectable mode accepts only levels confirmed by the provider or official catalog.',
                  )}
                  rules={[{ required: true }]}
                />
                {discovered &&
                (candidateLevels.length !== confirmed.size ||
                  candidateLevels.some((level) => !confirmed.has(level))) ? (
                  <Button
                    size="small"
                    style={{ marginBottom: 16 }}
                    onClick={() => {
                      modelFormRef.current?.setFieldValue(
                        'supportedThinkingLevels',
                        candidateLevels,
                      );
                    }}
                  >
                    {tr('套用最新來源／官方確認檔位', 'Apply latest provider/official levels')}
                  </Button>
                ) : null}
                <ProFormDependency name={['thinkingControlMode']}>
                  {({ thinkingControlMode }) =>
                    thinkingControlMode === 'USER_SELECTABLE' ? (
                      <Alert
                        type="info"
                        showIcon
                        message={tr(
                          `使用者可自行選擇：${[...confirmed].join('、')}`,
                          `Users may choose: ${[...confirmed].join(', ')}`,
                        )}
                        description={tr(
                          '使用者未指定時採 Provider 預設，不會注入 Thinking。未列出的檔位會在呼叫上游前被拒絕。',
                          'When omitted, the provider default is used and no thinking value is injected. Unlisted levels are rejected before calling upstream.',
                        )}
                        style={{ marginBottom: 16 }}
                      />
                    ) : (
                      <>
                        <ProFormSelect
                          name="thinkingLevel"
                          label={tr('伺服器 Thinking 強度', 'Server-controlled thinking')}
                          options={selectableLevels.map((value) => ({
                            value,
                            label:
                              value === 'PROVIDER_DEFAULT'
                                ? tr('Provider 預設（建議）', 'Provider default (recommended)')
                                : confirmed.has(value)
                                  ? tr(`${value}（來源確認）`, `${value} (provider-confirmed)`)
                                  : tr(`${value}（未確認）`, `${value} (unconfirmed)`),
                          }))}
                          tooltip={tr(
                            '客戶傳入的 Thinking 設定會被移除，再由伺服器套用此固定值。',
                            'Client thinking settings are removed and replaced with this server-controlled value.',
                          )}
                          rules={[{ required: true }]}
                        />
                        <Alert
                          type={hasConfirmedLevels ? 'info' : 'warning'}
                          showIcon
                          message={
                            hasConfirmedLevels
                              ? tr(
                                  `來源明確回報的 Thinking 檔位：${[...confirmed].join('、')}`,
                                  `Provider-confirmed thinking levels: ${[...confirmed].join(', ')}`,
                                )
                              : tr(
                                  '模型清單沒有回報 Thinking 檔位；只能使用伺服器固定模式，Provider 預設最安全。',
                                  'The model list did not report thinking levels. Only server-fixed mode is available, and provider default is safest.',
                                )
                          }
                          style={{ marginBottom: 16 }}
                        />
                      </>
                    )
                  }
                </ProFormDependency>
              </>
            );
          }}
        </ProFormDependency>
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
