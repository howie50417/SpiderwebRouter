import {
  CheckCircleOutlined,
  CopyOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  ModalForm,
  ProFormDateTimePicker,
  ProFormText,
  ProTable,
  type ActionType,
  type ProColumns,
} from '@ant-design/pro-components';
import { App, Button, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { PageIntro } from '@/components/PageIntro';
import { EnabledBadge } from '@/components/StatusBadge';
import { useAppSettings } from '@/context/AppSettings';
import { formatDateTime } from '@/lib/format';
import type { ApiKeyRecord, CreatedApiKey } from '@/types';

interface KeyFormValues {
  name: string;
  expiresAt?: string;
}

export function ApiKeysPage() {
  const tableRef = useRef<ActionType | undefined>(undefined);
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [formOpen, setFormOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey>();

  const notifyError = (reason: unknown) => {
    const error = getSafeError(reason);
    message.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`);
  };

  const revoke = async (key: ApiKeyRecord) => {
    try {
      await apiClient.delete(endpoints.myApiKey(key.id));
      message.success(tr('API Key 已撤銷', 'API key revoked'));
      tableRef.current?.reload();
    } catch (error) {
      notifyError(error);
    }
  };

  const columns: ProColumns<ApiKeyRecord>[] = [
    {
      title: tr('名稱', 'Name'),
      dataIndex: 'name',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.name}</Typography.Text>
          <Typography.Text type="secondary" code>
            {row.prefix}••••••••{row.lastFour}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'enabled',
      valueType: 'select',
      valueEnum: {
        true: { text: tr('有效', 'Active') },
        false: { text: tr('已撤銷', 'Revoked') },
      },
      width: 110,
      render: (_, row) => <EnabledBadge enabled={row.enabled} />,
    },
    {
      title: tr('最後使用', 'Last used'),
      dataIndex: 'lastUsedAt',
      valueType: 'dateTime',
      search: false,
      width: 180,
      renderText: (value) => formatDateTime(value, locale),
    },
    {
      title: tr('到期時間', 'Expires'),
      dataIndex: 'expiresAt',
      valueType: 'dateTime',
      search: false,
      width: 180,
      render: (_, row) =>
        row.expiresAt ? formatDateTime(row.expiresAt, locale) : <Tag>{tr('永不', 'Never')}</Tag>,
    },
    {
      title: tr('建立時間', 'Created'),
      dataIndex: 'createdAt',
      valueType: 'dateTime',
      search: false,
      width: 180,
      renderText: (value) => formatDateTime(value, locale),
    },
    {
      title: tr('操作', 'Actions'),
      valueType: 'option',
      fixed: 'right',
      width: 100,
      render: (_, row) =>
        row.enabled ? (
          <Popconfirm
            title={tr('永久撤銷這把 API Key？', 'Permanently revoke this API key?')}
            description={tr(
              '使用此 Key 的請求會立即停止。此操作無法復原。',
              'Requests using this key will stop immediately. This cannot be undone.',
            )}
            okButtonProps={{ danger: true }}
            onConfirm={() => void revoke(row)}
          >
            <Button type="link" size="small" danger>
              {tr('撤銷', 'Revoke')}
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <>
      <PageIntro
        eyebrow={tr('開發者控制台', 'Developer console')}
        title="API Keys"
        description={tr(
          'Key 完整值只會顯示一次。請存放在密碼管理器或 Secret Manager，切勿提交到原始碼。',
          'A key is shown only once. Store it in a password manager or secret manager and never commit it to source control.',
        )}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
            {tr('建立 API Key', 'Create API key')}
          </Button>
        }
      />

      <div className="security-banner">
        <SafetyCertificateOutlined />
        <div>
          <Typography.Text strong>
            {tr('每把 Key 都使用你的模型授權', 'Every key uses your model grants')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {tr(
              '建立 Key 不會增加可用模型；超管授權的模型與別名會立即套用。',
              'Creating a key does not add models. Administrator grants and aliases apply immediately.',
            )}
          </Typography.Text>
        </div>
      </div>

      <ProTable<ApiKeyRecord>
        actionRef={tableRef}
        rowKey="id"
        columns={columns}
        cardBordered
        scroll={{ x: 980 }}
        search={{ labelWidth: 'auto', defaultCollapsed: false }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          try {
            const result = await apiClient.list<ApiKeyRecord>(endpoints.myApiKeys, {
              page: params.current,
              pageSize: params.pageSize,
              search: typeof params.name === 'string' ? params.name : undefined,
              enabled: typeof params.enabled === 'boolean' ? params.enabled : undefined,
            });
            return { ...result, success: true };
          } catch (error) {
            notifyError(error);
            return { data: [], total: 0, success: false };
          }
        }}
        toolBarRender={() => [
          <Button key="reload" icon={<ReloadOutlined />} onClick={() => tableRef.current?.reload()}>
            {tr('重新整理', 'Refresh')}
          </Button>,
        ]}
      />

      <ModalForm<KeyFormValues>
        title={tr('建立 API Key', 'Create API key')}
        open={formOpen}
        modalProps={{ destroyOnClose: true, onCancel: () => setFormOpen(false) }}
        onFinish={async (values) => {
          try {
            const key = await apiClient.post<CreatedApiKey>(endpoints.myApiKeys, values);
            setCreatedKey(key);
            setFormOpen(false);
            tableRef.current?.reload();
            return true;
          } catch (error) {
            notifyError(error);
            return false;
          }
        }}
      >
        <ProFormText
          name="name"
          label={tr('名稱', 'Name')}
          placeholder={tr('例如：本機 Codex', 'e.g. Local Codex')}
          rules={[{ required: true }, { max: 80 }]}
        />
        <ProFormDateTimePicker
          name="expiresAt"
          label={tr('到期時間（選填）', 'Expiration (optional)')}
          fieldProps={{ showTime: true }}
        />
      </ModalForm>

      <Modal
        open={Boolean(createdKey)}
        title={tr('API Key 已建立', 'API key created')}
        closable={false}
        maskClosable={false}
        cancelButtonProps={{ style: { display: 'none' } }}
        okText={tr('我已安全保存', 'I saved it securely')}
        onOk={() => setCreatedKey(undefined)}
      >
        <Space direction="vertical" size={16} className="full-width">
          <div className="success-callout">
            <CheckCircleOutlined />
            <Typography.Text>
              {tr(
                '請立即複製。關閉後無法再次查看完整值。',
                'Copy it now. The full value cannot be viewed again after closing.',
              )}
            </Typography.Text>
          </div>
          <div className="secret-display">
            <Typography.Text code>{createdKey?.key}</Typography.Text>
            <Button
              type="primary"
              icon={<CopyOutlined />}
              onClick={() => {
                if (!createdKey?.key) return;
                void navigator.clipboard
                  .writeText(createdKey.key)
                  .then(() => message.success(tr('已複製', 'Copied')));
              }}
            >
              {tr('複製', 'Copy')}
            </Button>
          </div>
        </Space>
      </Modal>
    </>
  );
}
