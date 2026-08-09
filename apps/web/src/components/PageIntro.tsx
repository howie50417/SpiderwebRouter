import { Breadcrumb, Space, Typography } from 'antd';
import type { ReactNode } from 'react';

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-intro">
      <div className="page-intro__copy">
        {eyebrow ? <Breadcrumb items={[{ title: eyebrow }]} className="page-eyebrow" /> : null}
        <Typography.Title level={2}>{title}</Typography.Title>
        {description ? (
          <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
        ) : null}
      </div>
      {actions ? <Space wrap>{actions}</Space> : null}
    </header>
  );
}
