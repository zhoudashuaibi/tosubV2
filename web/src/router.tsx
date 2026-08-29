import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/api';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthLayout } from '@/components/layout/auth-layout';
import { LoginPage } from '@/pages/login';
import { DashboardPage } from '@/pages/dashboard';
import { ReservePoolPage } from '@/pages/pools/reserve';
import { MainPoolPage } from '@/pages/pools/main';
import { DiscardPoolPage } from '@/pages/pools/discard';
import { TeamPoolPage } from '@/pages/pools/team';
import { JobsPage } from '@/pages/jobs';
import { ProxiesPage } from '@/pages/proxies';
import { Sub2ApiPage } from '@/pages/sub2api';
import { SettingsPage } from '@/pages/settings';

/** 根路由：只挂全局 Provider，不做认证守卫（login 页必须在守卫之外）。 */
function RootLayout() {
  return (
    <TooltipProvider delayDuration={200}>
      <Outlet />
    </TooltipProvider>
  );
}

/** 认证守卫布局：session 探测 + 未登录跳转。所有受保护页面挂在这下面。 */
function AuthGuardLayout() {
  const { data: session, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: () => authApi.session(),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-10 w-10 animate-pulse items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            S2
          </div>
          <div className="text-sm text-muted-foreground">toSub2 控制台加载中…</div>
        </div>
      </div>
    );
  }

  if (!session?.authenticated) {
    return <Navigate to="/login" />;
  }

  return <Outlet />;
}

const rootRoute = createRootRoute({ component: RootLayout });

const authLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  component: AuthGuardLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const indexRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/',
  component: withLayout('概览', DashboardPage),
});

const reserveRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/reserve',
  component: withLayout('备用号池', ReservePoolPage),
});

const mainRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/main',
  component: withLayout('主号池', MainPoolPage),
});

const discardRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/discard',
  component: withLayout('废弃号池', DiscardPoolPage),
});

const teamRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/team',
  component: withLayout('Team号池', TeamPoolPage),
});

const jobsRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/jobs',
  component: withLayout('任务中心', JobsPage),
});

const proxiesRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/proxies',
  component: withLayout('代理列表', ProxiesPage),
});

const sub2apiRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/sub2api',
  component: withLayout('Sub2API 管理', Sub2ApiPage),
});

const settingsRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/settings',
  component: withLayout('设置', SettingsPage),
});

function withLayout(title: string, Page: React.ComponentType) {
  function Wrapped() {
    return (
      <AuthLayout title={title}>
        <Page />
      </AuthLayout>
    );
  }
  Wrapped.displayName = `Page(${title})`;
  return Wrapped;
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  authLayoutRoute.addChildren([
    indexRoute,
    reserveRoute,
    mainRoute,
    discardRoute,
    teamRoute,
    jobsRoute,
    proxiesRoute,
    sub2apiRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// client.ts 触发的 401 事件 → 清缓存跳登录
if (typeof window !== 'undefined') {
  window.addEventListener('tosub2:unauthorized', () => {
    window.location.href = '/login';
  });
}
