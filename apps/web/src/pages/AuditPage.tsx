import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  ProDescriptions,
  ProTable,
  type ActionType,
  type ProColumns,
} from '@ant-design/pro-components';
import { Button, Drawer, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';

import { apiClient, getSafeError } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { PageIntro } from '@/components/PageIntro';
import { useAppSettings } from '@/context/AppSettings';
import { formatDateTime } from '@/lib/format';
import type { AuditRecord } from '@/types';
import { App } from 'antd';

export function AuditPage() {
  const tableRef = useRef<ActionType | undefined>(undefined);
  const { message } = App.useApp();
  const { locale, tr } = useAppSettings();
  const [selected, setSelected] = useState<AuditRecord>();

  const columns: ProColumns<AuditRecord>[] = [
    {
      title: tr('時間', 'Time'),
      dataIndex: 'createdAt',
      valueType: 'dateRange',
      width: 190,
      fixed: 'left',
      renderText: (value) => formatDateTime(value, locale),
    },
    {
      title: tr('操作者', 'Actor'),
      dataIndex: 'actorEmail',
      copyable: true,
      width: 220,
      renderText: (value) => value || tr('系統', 'System'),
    },
    {
      title: tr('動作', 'Action'),
      dataIndex: 'action',
      copyable: true,
      render: (_, row) => <Tag color="blue">{row.action}</Tag>,
    },
    {
      title: tr('資源', 'Resource'),
      dataIndex: 'resourceType',
      width: 170,
    },
    {
      title: 'Resource ID',
      dataIndex: 'resourceId',
      search: false,
      copyable: true,
      ellipsis: true,
      width: 170,
    },
    {
      title: tr('來源 IP', 'Source IP'),
      dataIndex: 'ipAddress',
      search: false,
      width: 140,
      renderText: (value) => value || '—',
    },
    {
      title: tr('追蹤編號', 'Request ID'),
      dataIndex: 'requestId',
      copyable: true,
      ellipsis: true,
      width: 170,
    },
    {
      title: tr('操作', 'Actions'),
      valueType: 'option',
      fixed: 'right',
      width: 100,
      render: (_, row) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setSelected(row)}>
          {tr('查看', 'View')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageIntro
        eyebrow={tr('超管', 'Administration')}
        title={tr('稽核日誌', 'Audit log')}
        description={tr(
          '追蹤角色、來源、模型、價格與授權變更。憑證與推理內容已從事件中遮罩。',
          'Trace role, provider, model, pricing, and grant changes. Credentials and inference content are redacted.',
        )}
      />
      <ProTable<AuditRecord>
        actionRef={tableRef}
        rowKey="id"
        columns={columns}
        cardBordered
        scroll={{ x: 1_250 }}
        search={{ labelWidth: 'auto', defaultCollapsed: false }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          const dateRange = Array.isArray(params.createdAt) ? params.createdAt : undefined;
          try {
            const result = await apiClient.list<AuditRecord>(endpoints.audit, {
              page: params.current,
              pageSize: params.pageSize,
              actor: typeof params.actorEmail === 'string' ? params.actorEmail : undefined,
              action: typeof params.action === 'string' ? params.action : undefined,
              resourceType:
                typeof params.resourceType === 'string' ? params.resourceType : undefined,
              requestId: typeof params.requestId === 'string' ? params.requestId : undefined,
              from: dateRange?.[0] ? String(dateRange[0]) : undefined,
              to: dateRange?.[1] ? String(dateRange[1]) : undefined,
            });
            return { ...result, success: true };
          } catch (reason) {
            const error = getSafeError(reason);
            message.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`);
            return { data: [], total: 0, success: false };
          }
        }}
        toolBarRender={() => [
          <Button key="reload" icon={<ReloadOutlined />} onClick={() => tableRef.current?.reload()}>
            {tr('重新整理', 'Refresh')}
          </Button>,
        ]}
      />
      <Drawer
        width={620}
        open={Boolean(selected)}
        title={tr('稽核事件', 'Audit event')}
        onClose={() => setSelected(undefined)}
      >
        {selected ? (
          <>
            <ProDescriptions<AuditRecord>
              column={1}
              dataSource={selected}
              columns={[
                {
                  title: tr('時間', 'Time'),
                  renderText: (value) => formatDateTime(value, locale),
                  dataIndex: 'createdAt',
                },
                { title: tr('操作者', 'Actor'), dataIndex: 'actorEmail', copyable: true },
                { title: tr('動作', 'Action'), dataIndex: 'action', copyable: true },
                { title: tr('資源類型', 'Resource type'), dataIndex: 'resourceType' },
                { title: 'Resource ID', dataIndex: 'resourceId', copyable: true },
                { title: tr('追蹤編號', 'Request ID'), dataIndex: 'requestId', copyable: true },
              ]}
            />
            <Typography.Title level={5}>{tr('去敏後變更', 'Redacted changes')}</Typography.Title>
            <pre className="code-panel">{JSON.stringify(selected.changes ?? {}, null, 2)}</pre>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
