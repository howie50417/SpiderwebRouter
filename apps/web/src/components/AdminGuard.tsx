import { useGetIdentity } from '@refinedev/core';
import { Navigate, Outlet } from 'react-router-dom';

import { PageSkeleton } from '@/components/AsyncState';
import type { Identity } from '@/types';

export function AdminGuard() {
  const { data, isLoading } = useGetIdentity<Identity>();
  if (isLoading) return <PageSkeleton />;
  const allowed = data?.roles.includes('SUPER_ADMIN');
  return allowed ? <Outlet /> : <Navigate to="/forbidden" replace />;
}
