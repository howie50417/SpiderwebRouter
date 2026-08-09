import {
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import {
  ModalForm,
  ProDescriptions,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
  type ActionType,
  type ProColumns,
} from '@ant-design/pro-components';
import { Alert, App, Button, Drawer, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { PageIntro } from '@/components/PageIntro';
import { EnabledBadge } from '@/components/StatusBadge';
import { useAppSettings } from '@/context/AppSettings';
import { formatDateTime, formatUsd } from '@/lib/format';
import { modelAliasPattern } from '@/lib/modelAlias';
import type { PublishedModel, Role, UserModelGrant, UserRecord } from '@/types';

interface UserFormValues {
  email: string;
  displayName: string;
  role: Role;
  temporaryPassword?: string;
  enabled: boolean;
}

interface GrantFormValues {
  publishedModelId: string;
  alias: string;
  customInputPriceUsdPerMillion?: number | null;
  customOutputPriceUsdPerMillion?: number | null;
  enabled: boolean;
}

export function UsersPage() {
  const userTableRef = useRef<ActionType | undefined>(undefined);
  const grantTableRef = useRef<ActionType | undefined>(undefined);
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRecord>();
  const [grantFormOpen, setGrantFormOpen] = useState(false);
  const [editingGrant, setEditingGrant] = useState<UserModelGrant>();
  const [generatedCredential, setGeneratedCredential] = useState<{
    email: string;
    password: string;
  }>();

  const notifyError = (reason: unknown) => {
    const error = getSafeError(reason);
    message.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`);
  };

  const toggleUser = async (user: UserRecord) => {
    try {
      await apiClient.patch(endpoints.user(user.id), { enabled: !user.enabled });
      message.success(
        user.enabled ? tr('使用者已停用', 'User disabled') : tr('使用者已啟用', 'User enabled'),
      );
      userTableRef.current?.reload();
      if (selectedUser?.id === user.id) setSelectedUser({ ...user, enabled: !user.enabled });
    } catch (error) {
      notifyError(error);
    }
  };

  const removeGrant = async (grant: UserModelGrant) => {
    if (!selectedUser) return;
    try {
      await apiClient.delete(endpoints.userGrant(selectedUser.id, grant.id));
      message.success(tr('模型授權已移除', 'Model grant removed'));
      grantTableRef.current?.reload();
      userTableRef.current?.reload();
    } catch (error) {
      notifyError(error);
    }
  };

  const userColumns: ProColumns<UserRecord>[] = [
    {
      title: tr('使用者', 'User'),
      dataIndex: 'email',
      copyable: true,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.displayName || row.email}</Typography.Text>
          <Typography.Text type="secondary">{row.email}</Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('角色', 'Role'),
      dataIndex: 'roles',
      valueType: 'select',
      valueEnum: {
        SUPER_ADMIN: { text: 'Super admin' },
        ADMIN: { text: 'Admin' },
        USER: { text: 'User' },
      },
      width: 160,
      render: (_, row) => (
        <Space wrap>
          {row.roles.map((role) => (
            <Tag
              key={role}
              color={role === 'SUPER_ADMIN' ? 'purple' : role === 'ADMIN' ? 'blue' : undefined}
            >
              {role}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: tr('可用模型', 'Model grants'),
      dataIndex: 'modelGrantCount',
      search: false,
      width: 110,
      renderText: (value) => value ?? 0,
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'enabled',
      valueType: 'select',
      valueEnum: {
        true: { text: tr('啟用', 'Enabled') },
        false: { text: tr('停用', 'Disabled') },
      },
      width: 110,
      render: (_, row) => <EnabledBadge enabled={row.enabled} />,
    },
    {
      title: tr('最後登入', 'Last sign-in'),
      dataIndex: 'lastLoginAt',
      valueType: 'dateTime',
      search: false,
      width: 180,
      renderText: (value) => formatDateTime(value, locale),
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
      width: 210,
      render: (_, row) => [
        <Button
          key="grants"
          type="link"
          size="small"
          icon={<KeyOutlined />}
          onClick={() => setSelectedUser(row)}
        >
          {tr('模型授權', 'Model grants')}
        </Button>,
        <Popconfirm
          key="toggle"
          title={
            row.enabled
              ? tr('停用這位使用者？', 'Disable this user?')
              : tr('啟用這位使用者？', 'Enable this user?')
          }
          description={
            row.enabled
              ? tr('現有 API Key 將無法繼續使用。', 'Existing API keys will stop working.')
              : undefined
          }
          onConfirm={() => void toggleUser(row)}
        >
          <Button type="link" size="small" danger={row.enabled} icon={<StopOutlined />}>
            {row.enabled ? tr('停用', 'Disable') : tr('啟用', 'Enable')}
          </Button>
        </Popconfirm>,
      ],
    },
  ];

  const grantColumns: ProColumns<UserModelGrant>[] = [
    {
      title: tr('模型', 'Model'),
      dataIndex: 'modelName',
      search: false,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.modelName}</Typography.Text>
          <Typography.Text type="secondary" code>
            {row.alias}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: tr('輸入價格', 'Input price'),
      dataIndex: 'customInputPriceUsdPerMillion',
      search: false,
      renderText: (value) =>
        value === null || value === undefined ? tr('繼承全局', 'Global') : formatUsd(value, locale),
    },
    {
      title: tr('輸出價格', 'Output price'),
      dataIndex: 'customOutputPriceUsdPerMillion',
      search: false,
      renderText: (value) =>
        value === null || value === undefined ? tr('繼承全局', 'Global') : formatUsd(value, locale),
    },
    {
      title: tr('狀態', 'Status'),
      dataIndex: 'enabled',
      search: false,
      render: (_, row) => <EnabledBadge enabled={row.enabled} />,
    },
    {
      title: tr('操作', 'Actions'),
      valueType: 'option',
      render: (_, row) => [
        <Button
          key="edit"
          type="link"
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setEditingGrant(row);
            setGrantFormOpen(true);
          }}
        >
          {tr('編輯', 'Edit')}
        </Button>,
        <Popconfirm
          key="remove"
          title={tr('移除模型授權？', 'Remove this model grant?')}
          onConfirm={() => void removeGrant(row)}
        >
          <Button type="link" size="small" danger>
            {tr('移除', 'Remove')}
          </Button>
        </Popconfirm>,
      ],
    },
  ];

  return (
    <>
      <PageIntro
        eyebrow={tr('超管', 'Administration')}
        title={tr('使用者與模型授權', 'Users and model grants')}
        description={tr(
          '新使用者預設沒有任何可用模型。授權時可設定專屬別名與價格；空白價格會繼承全局，0 表示免費。',
          'New users start with zero models. Each grant can define a private alias and pricing; blank inherits global pricing and zero means free.',
        )}
        actions={
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setUserFormOpen(true)}>
            {tr('建立使用者', 'Create user')}
          </Button>
        }
      />

      <ProTable<UserRecord>
        actionRef={userTableRef}
        rowKey="id"
        columns={userColumns}
        cardBordered
        scroll={{ x: 1_150 }}
        search={{ labelWidth: 'auto', defaultCollapsed: false }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          try {
            const result = await apiClient.list<UserRecord>(endpoints.users, {
              page: params.current,
              pageSize: params.pageSize,
              search: typeof params.email === 'string' ? params.email : undefined,
              role: Array.isArray(params.roles)
                ? String(params.roles[0])
                : typeof params.roles === 'string'
                  ? params.roles
                  : undefined,
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
            onClick={() => userTableRef.current?.reload()}
          >
            {tr('重新整理', 'Refresh')}
          </Button>,
        ]}
      />

      <ModalForm<UserFormValues>
        title={tr('建立使用者', 'Create user')}
        open={userFormOpen}
        modalProps={{ destroyOnClose: true, onCancel: () => setUserFormOpen(false) }}
        initialValues={{ role: 'USER', enabled: true }}
        onFinish={async (values) => {
          try {
            const created = await apiClient.post<{
              email?: string;
              generatedTemporaryPassword?: string;
            }>(endpoints.users, values);
            if (created.generatedTemporaryPassword) {
              setGeneratedCredential({
                email: created.email ?? values.email,
                password: created.generatedTemporaryPassword,
              });
            }
            message.success(
              tr('使用者已建立；目前可用模型為 0。', 'User created with zero model grants.'),
            );
            setUserFormOpen(false);
            userTableRef.current?.reload();
            return true;
          } catch (error) {
            notifyError(error);
            return false;
          }
        }}
      >
        <ProFormText
          name="email"
          label="Email"
          fieldProps={{ autoComplete: 'off' }}
          rules={[{ required: true, type: 'email' }]}
        />
        <ProFormText
          name="displayName"
          label={tr('顯示名稱', 'Display name')}
          rules={[{ required: true }, { max: 100 }]}
        />
        <ProFormSelect
          name="role"
          label={tr('角色', 'Role')}
          options={[
            { value: 'USER', label: 'User' },
            { value: 'SUPER_ADMIN', label: 'Super admin' },
          ]}
          rules={[{ required: true }]}
        />
        <ProFormText.Password
          name="temporaryPassword"
          label={tr('暫時密碼（選填）', 'Temporary password (optional)')}
          fieldProps={{ autoComplete: 'new-password' }}
          tooltip={tr(
            '留空則由系統安全產生。使用者首次登入只需更換密碼，預設不要求 TOTP。',
            'Leave blank to generate securely. First sign-in requires a password change only; TOTP is off by default.',
          )}
          rules={[{ min: 12 }]}
        />
        <ProFormSwitch name="enabled" label={tr('啟用帳號', 'Enable account')} />
      </ModalForm>

      <Modal
        open={Boolean(generatedCredential)}
        title={tr('儲存暫時密碼', 'Save the temporary password')}
        okText={tr('我已安全保存', 'I saved it securely')}
        cancelButtonProps={{ style: { display: 'none' } }}
        closable={false}
        maskClosable={false}
        keyboard={false}
        onOk={() => setGeneratedCredential(undefined)}
      >
        <Alert
          type="warning"
          showIcon
          message={tr('密碼只會顯示這一次', 'This password is shown only once')}
          description={tr(
            '請透過安全管道交付給使用者；關閉後無法再次讀取。',
            'Send it to the user through a secure channel. It cannot be retrieved after this dialog closes.',
          )}
        />
        <Typography.Paragraph style={{ marginTop: 20, marginBottom: 6 }} type="secondary">
          {generatedCredential?.email}
        </Typography.Paragraph>
        <Typography.Paragraph
          code
          strong
          copyable={generatedCredential ? { text: generatedCredential.password } : false}
          style={{ fontSize: 16, wordBreak: 'break-all' }}
        >
          {generatedCredential?.password}
        </Typography.Paragraph>
      </Modal>

      <Drawer
        width={760}
        open={Boolean(selectedUser)}
        title={
          selectedUser
            ? `${selectedUser.displayName || selectedUser.email} · ${tr('模型授權', 'Model grants')}`
            : undefined
        }
        onClose={() => setSelectedUser(undefined)}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingGrant(undefined);
              setGrantFormOpen(true);
            }}
          >
            {tr('授權模型', 'Grant model')}
          </Button>
        }
      >
        {selectedUser ? (
          <>
            <ProDescriptions<UserRecord>
              column={2}
              dataSource={selectedUser}
              columns={[
                { title: 'Email', dataIndex: 'email', copyable: true },
                {
                  title: tr('狀態', 'Status'),
                  render: (_, row) => <EnabledBadge enabled={row.enabled} />,
                },
                { title: tr('角色', 'Role'), render: (_, row) => row.roles.join(', ') },
                { title: tr('可用模型', 'Model grants'), dataIndex: 'modelGrantCount' },
              ]}
            />
            <ProTable<UserModelGrant>
              actionRef={grantTableRef}
              rowKey="id"
              columns={grantColumns}
              search={false}
              cardBordered={false}
              pagination={false}
              options={{ density: false, fullScreen: false }}
              request={async () => {
                try {
                  const result = await apiClient.list<UserModelGrant>(
                    endpoints.userGrants(selectedUser.id),
                    { pageSize: 500 },
                  );
                  return { ...result, success: true };
                } catch (error) {
                  notifyError(error);
                  return { data: [], total: 0, success: false };
                }
              }}
            />
          </>
        ) : null}
      </Drawer>

      <ModalForm<GrantFormValues>
        key={editingGrant?.id ?? 'new-grant'}
        title={
          editingGrant ? tr('編輯模型授權', 'Edit model grant') : tr('授權模型', 'Grant model')
        }
        open={grantFormOpen}
        modalProps={{ destroyOnClose: true, onCancel: () => setGrantFormOpen(false) }}
        initialValues={
          editingGrant
            ? {
                publishedModelId: editingGrant.publishedModelId,
                alias: editingGrant.alias,
                customInputPriceUsdPerMillion:
                  editingGrant.customInputPriceUsdPerMillion === null
                    ? undefined
                    : Number(editingGrant.customInputPriceUsdPerMillion),
                customOutputPriceUsdPerMillion:
                  editingGrant.customOutputPriceUsdPerMillion === null
                    ? undefined
                    : Number(editingGrant.customOutputPriceUsdPerMillion),
                enabled: editingGrant.enabled,
              }
            : { enabled: true }
        }
        onFinish={async (values) => {
          if (!selectedUser) return false;
          try {
            const payload = {
              ...values,
              customInputPriceUsdPerMillion:
                values.customInputPriceUsdPerMillion === undefined ||
                values.customInputPriceUsdPerMillion === null
                  ? null
                  : String(values.customInputPriceUsdPerMillion),
              customOutputPriceUsdPerMillion:
                values.customOutputPriceUsdPerMillion === undefined ||
                values.customOutputPriceUsdPerMillion === null
                  ? null
                  : String(values.customOutputPriceUsdPerMillion),
            };
            if (editingGrant) {
              await apiClient.post(endpoints.grants, {
                ...payload,
                userId: selectedUser.id,
                publishedModelId: editingGrant.publishedModelId,
              });
            } else {
              await apiClient.post(endpoints.grants, {
                ...payload,
                userId: selectedUser.id,
              });
            }
            message.success(
              editingGrant ? tr('授權已更新', 'Grant updated') : tr('模型已授權', 'Model granted'),
            );
            setGrantFormOpen(false);
            grantTableRef.current?.reload();
            userTableRef.current?.reload();
            return true;
          } catch (error) {
            notifyError(error);
            return false;
          }
        }}
      >
        <ProFormSelect
          name="publishedModelId"
          label={tr('模型', 'Model')}
          disabled={Boolean(editingGrant)}
          request={async () => {
            try {
              const result = await apiClient.list<PublishedModel>(endpoints.publishedModels, {
                pageSize: 500,
                enabled: true,
              });
              return result.data.map((model) => ({
                label: `${model.publicName} · ${model.providerName}`,
                value: model.id,
              }));
            } catch (error) {
              notifyError(error);
              return [];
            }
          }}
          rules={[{ required: true }]}
        />
        <ProFormText
          name="alias"
          label={tr('使用者專屬模型名稱', 'User-visible model alias')}
          tooltip={tr(
            '同一使用者的別名必須唯一；上游模型名稱永遠不會對客戶顯示。',
            'Aliases must be unique per user. Upstream model IDs are never shown to customers.',
          )}
          rules={[
            { required: true },
            {
              pattern: modelAliasPattern,
              message: tr(
                '別名可使用英數、點、底線、冒號、斜線與連字號',
                'Use letters, numbers, dot, underscore, colon, slash, or hyphen',
              ),
            },
          ]}
        />
        <ProFormDigit
          name="customInputPriceUsdPerMillion"
          label={tr('自訂輸入價格（空白＝繼承）', 'Custom input price (blank = global)')}
          min={0}
          max={1_000_000}
          fieldProps={{ precision: 6, prefix: '$' }}
        />
        <ProFormDigit
          name="customOutputPriceUsdPerMillion"
          label={tr('自訂輸出價格（空白＝繼承）', 'Custom output price (blank = global)')}
          min={0}
          max={1_000_000}
          fieldProps={{ precision: 6, prefix: '$' }}
        />
        <ProFormSwitch name="enabled" label={tr('啟用授權', 'Enable grant')} />
      </ModalForm>
    </>
  );
}
