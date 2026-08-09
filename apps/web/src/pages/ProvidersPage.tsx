import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  ModalForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
  type ActionType,
  type ProColumns,
} from '@ant-design/pro-components';
import {
  providerAuthModes,
  providerTypes,
  type ProviderAuthMode,
  type ProviderType,
} from '@spiderwebrouter/contracts';
import { App, Button, Popconfirm, Space, Tooltip, Typography } from 'antd';
import { useRef, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { EnabledBadge, StatusBadge } from '@/components/StatusBadge';
import { PageIntro } from '@/components/PageIntro';
import { useAppSettings } from '@/context/AppSettings';
import { formatDateTime } from '@/lib/format';
import type { ProviderRecord } from '@/types';

interface ProviderFormValues {
  name: string;
  type: ProviderType;
  baseUrl: string;
  authMode: ProviderAuthMode;
  secret?: string;
  timeoutMs: number;
  enabled: boolean;
}

interface DeleteProviderResult {
  id: string;
  deleted: boolean;
  hidden: boolean;
  mode: 'HARD_DELETE' | 'ARCHIVED';
  reason: 'HISTORY_PRESERVED' | null;
}

export function ProvidersPage() {
  const actionRef = useRef<ActionType | undefined>(undefined);
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [editing, setEditing] = useState<ProviderRecord>();
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string>();

  const notifyError = (reason: unknown) => {
    const error = getSafeError(reason);
    message.error(
      `${error.message}${error.requestId ? ` (${tr('追蹤編號', 'Request ID')}: ${error.requestId})` : ''}`,
    );
  };

  const testConnection = async (provider: ProviderRecord) => {
    setBusyId(`test:${provider.id}`);
    try {
      await apiClient.post(endpoints.providerTest(provider.id));
      message.success(tr('連線測試成功', 'Connection test succeeded'));
      actionRef.current?.reload();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusyId(undefined);
    }
  };

  const scan = async (providerId?: string) => {
    setBusyId(providerId ? `scan:${providerId}` : 'scan:all');
    try {
      if (providerId) {
        await apiClient.post(endpoints.providerScan(providerId));
      } else {
        const providers = await apiClient.list<ProviderRecord>(endpoints.providers, {
          pageSize: 500,
          enabled: true,
        });
        const results = await Promise.allSettled(
          providers.data
            .filter((provider) => provider.enabled)
            .map((provider) => apiClient.post(endpoints.providerScan(provider.id))),
        );
        if (results.some((result) => result.status === 'rejected')) {
          throw results.find((result) => result.status === 'rejected')?.reason;
        }
      }
      message.success(tr('模型掃描已排入工作佇列', 'Model scan has been queued'));
    } catch (error) {
      notifyError(error);
    } finally {
      setBusyId(undefined);
    }
  };

  const deleteProvider = async (provider: ProviderRecord) => {
    setBusyId(`delete:${provider.id}`);
    try {
      const result = await apiClient.delete<DeleteProviderResult>(endpoints.provider(provider.id));
      message.success(
        result.mode === 'HARD_DELETE'
          ? tr('服務來源已永久刪除', 'Provider permanently deleted')
          : tr(
              '此來源已有使用或轉接嘗試紀錄，已安全封存並從列表隱藏。',
              'This provider has usage or provider-attempt history, so it was safely archived and hidden.',
            ),
      );
      actionRef.current?.reload();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusyId(undefined);
    }
  };

  const columns: ProColumns<ProviderRecord>[] = [
    {
      title: tr('名稱', 'Name'),
      dataIndex: 'name',
      copyable: true,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.name}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: row.baseUrl }}>
            {row.baseUrl}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('類型', 'Type'),
      dataIndex: 'type',
      valueType: 'select',
      valueEnum: Object.fromEntries(providerTypes.map((type) => [type, type])),
      width: 170,
    },
    {
      title: tr('認證', 'Authentication'),
      dataIndex: 'authMode',
      search: false,
      width: 120,
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'healthStatus',
      width: 120,
      render: (_, row) => <StatusBadge status={row.healthStatus} />,
    },
    {
      title: tr('啟用', 'Enabled'),
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
      title: tr('模型', 'Models'),
      dataIndex: 'discoveredModelCount',
      search: false,
      width: 90,
    },
    {
      title: tr('最後檢查', 'Last checked'),
      dataIndex: 'lastCheckedAt',
      valueType: 'dateTime',
      search: false,
      width: 180,
      renderText: (value) => formatDateTime(value, locale),
    },
    {
      title: tr('操作', 'Actions'),
      valueType: 'option',
      fixed: 'right',
      width: 290,
      render: (_, row) => [
        <Tooltip key="test" title={tr('不保存任何模型輸出', 'No model output is retained')}>
          <Button
            type="link"
            size="small"
            icon={<CheckCircleOutlined />}
            loading={busyId === `test:${row.id}`}
            onClick={() => void testConnection(row)}
          >
            {tr('測試', 'Test')}
          </Button>
        </Tooltip>,
        <Button
          key="scan"
          type="link"
          size="small"
          icon={<RadarChartOutlined />}
          loading={busyId === `scan:${row.id}`}
          onClick={() => void scan(row.id)}
        >
          {tr('掃描', 'Scan')}
        </Button>,
        <Button
          key="edit"
          type="link"
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setEditing(row);
            setFormOpen(true);
          }}
        >
          {tr('編輯', 'Edit')}
        </Button>,
        <Popconfirm
          key="delete"
          title={tr('刪除此服務來源？', 'Delete this provider?')}
          description={tr(
            '尚未產生歷史的模型會一併刪除；若已有使用或轉接嘗試紀錄，系統會改為封存並保留統計。',
            'Models without history are deleted with the provider. If usage or provider-attempt history exists, the provider is archived and statistics are preserved.',
          )}
          okText={tr('刪除', 'Delete')}
          cancelText={tr('取消', 'Cancel')}
          okButtonProps={{ danger: true, loading: busyId === `delete:${row.id}` }}
          onConfirm={() => deleteProvider(row)}
        >
          <Button
            danger
            type="link"
            size="small"
            icon={<DeleteOutlined />}
            loading={busyId === `delete:${row.id}`}
          >
            {tr('刪除', 'Delete')}
          </Button>
        </Popconfirm>,
      ],
    },
  ];

  return (
    <>
      <PageIntro
        eyebrow={tr('超管', 'Administration')}
        title={tr('服務來源', 'Providers')}
        description={tr(
          '集中管理 OpenAI、Gemini、vLLM、Ollama 與 Open WebUI 連線。金鑰建立後只可替換、不可讀回。',
          'Manage OpenAI, Gemini, vLLM, Ollama, and Open WebUI connections. Secrets can be replaced but never read back.',
        )}
        actions={
          <>
            <Button
              icon={<RadarChartOutlined />}
              loading={busyId === 'scan:all'}
              onClick={() => void scan()}
            >
              {tr('掃描全部', 'Scan all')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              {tr('新增來源', 'Add provider')}
            </Button>
          </>
        }
      />

      <ProTable<ProviderRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        cardBordered
        scroll={{ x: 1_200 }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        search={{ labelWidth: 'auto', defaultCollapsed: false }}
        request={async (params) => {
          try {
            const result = await apiClient.list<ProviderRecord>(endpoints.providers, {
              page: params.current,
              pageSize: params.pageSize,
              search: typeof params.name === 'string' ? params.name : undefined,
              type: typeof params.type === 'string' ? params.type : undefined,
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
            onClick={() => actionRef.current?.reload()}
          >
            {tr('重新整理', 'Refresh')}
          </Button>,
        ]}
      />

      <ModalForm<ProviderFormValues>
        key={editing?.id ?? 'new-provider'}
        title={editing ? tr('編輯服務來源', 'Edit provider') : tr('新增服務來源', 'Add provider')}
        open={formOpen}
        modalProps={{
          destroyOnClose: true,
          onCancel: () => setFormOpen(false),
        }}
        initialValues={
          editing
            ? {
                name: editing.name,
                type: editing.type,
                baseUrl: editing.baseUrl,
                authMode: editing.authMode,
                timeoutMs: editing.timeoutMs,
                enabled: editing.enabled,
              }
            : {
                type: 'OPENAI_COMPATIBLE',
                authMode: 'BEARER',
                timeoutMs: 60_000,
                enabled: true,
              }
        }
        onFinish={async (values) => {
          try {
            const payload = { ...values };
            if (!payload.secret) delete payload.secret;
            if (editing) {
              await apiClient.patch(endpoints.provider(editing.id), payload);
            } else {
              await apiClient.post(endpoints.providers, payload);
            }
            message.success(
              editing ? tr('來源已更新', 'Provider updated') : tr('來源已建立', 'Provider created'),
            );
            setFormOpen(false);
            actionRef.current?.reload();
            return true;
          } catch (error) {
            notifyError(error);
            return false;
          }
        }}
      >
        <ProFormText
          name="name"
          label={tr('顯示名稱', 'Display name')}
          placeholder="Production vLLM"
          rules={[{ required: true }, { max: 80 }]}
        />
        <ProFormSelect
          name="type"
          label={tr('來源類型', 'Provider type')}
          options={providerTypes.map((value) => ({ label: value, value }))}
          rules={[{ required: true }]}
        />
        <ProFormText
          name="baseUrl"
          label="Base URL"
          placeholder="https://provider.example.com/v1"
          tooltip={tr(
            '只允許安全的 HTTPS URL；內網 HTTP 必須由部署白名單明確允許。',
            'HTTPS is required unless an internal host is explicitly allowlisted at deployment.',
          )}
          rules={[{ required: true, type: 'url' }]}
        />
        <ProFormSelect
          name="authMode"
          label={tr('認證方式', 'Authentication')}
          options={providerAuthModes.map((value) => ({ label: value, value }))}
          rules={[{ required: true }]}
        />
        <ProFormText.Password
          name="secret"
          label={
            editing
              ? tr('替換憑證（選填）', 'Replace credential (optional)')
              : tr('Bearer / API 金鑰', 'Bearer / API key')
          }
          placeholder={editing?.secretConfigured ? '••••••••••••••••' : undefined}
          fieldProps={{ autoComplete: 'new-password' }}
          tooltip={tr(
            '送出後無法從後台讀回完整值。',
            'The complete value cannot be retrieved after submission.',
          )}
        />
        <ProFormDigit
          name="timeoutMs"
          label={tr('整體逾時（毫秒）', 'Overall timeout (ms)')}
          min={1_000}
          max={600_000}
          fieldProps={{ step: 1_000 }}
          rules={[{ required: true }]}
        />
        <ProFormSwitch name="enabled" label={tr('啟用', 'Enabled')} />
      </ModalForm>
    </>
  );
}
