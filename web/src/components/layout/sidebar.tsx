import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  Archive,
  Globe,
  Inbox,
  LayoutDashboard,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui';

const NAV = [
  { label: '概览', to: '/', icon: LayoutDashboard, exact: true },
  {
    label: '号池管理',
    items: [
      { label: '备用号池', to: '/pools/reserve', icon: Inbox },
      { label: '主号池', to: '/pools/main', icon: Users },
      { label: '废弃号池', to: '/pools/discard', icon: Archive },
    ],
  },
  { label: '任务中心', to: '/jobs', icon: ListChecks },
  { label: '代理列表', to: '/proxies', icon: Globe },
  { label: 'Sub2API', to: '/sub2api', icon: Server },
  { label: '设置', to: '/settings', icon: Settings },
].flatMap((entry) => ('items' in entry ? (entry.items as NavItem[]) : [entry as NavItem]));

type NavItem = { label: string; to: string; icon: typeof Globe; exact?: boolean };

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const matchRoute = useMatchRoute();

  return (
    <aside
      className={cn(
        'app-sidebar flex h-full flex-col border-r text-sidebar-foreground transition-[width] duration-300',
        sidebarCollapsed ? 'w-14' : 'w-56',
      )}
    >
      <div className="flex h-[60px] items-center gap-2.5 border-b px-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/35 bg-primary text-[11px] font-bold text-primary-foreground shadow-[0_0_18px_color-mix(in_srgb,var(--primary)_30%,transparent)]">
          S2
        </div>
        {!sidebarCollapsed && (
          <div className="min-w-0 leading-none">
            <span className="block truncate text-sm font-medium">toSub2</span>
            <span className="mt-1 block truncate font-mono text-[9px] tracking-[0.12em] text-muted-foreground">CONTROL ROOM</span>
          </div>
        )}
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {NAV.map((item) => {
          const active = matchRoute({ to: item.to, fuzzy: !item.exact });
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors duration-200',
                active
                  ? 'bg-sidebar-accent font-medium text-primary shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)]'
                  : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
              title={item.label}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-b-0 border-t p-2">
        <Button variant="ghost" size="sm" className="w-full justify-start rounded-md" onClick={toggleSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!sidebarCollapsed && '收起侧边栏'}
        </Button>
      </div>
    </aside>
  );
}
