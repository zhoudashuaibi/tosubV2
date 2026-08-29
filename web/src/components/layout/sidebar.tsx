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
  UsersRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui';

const NAV_SECTIONS = [
  { label: '工作台', items: [{ label: '概览', to: '/', icon: LayoutDashboard, exact: true }] },
  {
    label: '账号号池',
    items: [
      { label: '备用号池', to: '/pools/reserve', icon: Inbox },
      { label: '主号池', to: '/pools/main', icon: Users },
      { label: '废弃号池', to: '/pools/discard', icon: Archive },
    ],
  },
  {
    label: 'TEAM号池',
    items: [{ label: 'Team号池', to: '/pools/team', icon: UsersRound }],
  },
  {
    label: '系统管理',
    items: [
      { label: '任务中心', to: '/jobs', icon: ListChecks },
      { label: '代理列表', to: '/proxies', icon: Globe },
      { label: 'Sub2API', to: '/sub2api', icon: Server },
      { label: '设置', to: '/settings', icon: Settings },
    ],
  },
] satisfies { label: string; items: NavItem[] }[];

type NavItem = { label: string; to: string; icon: typeof Globe; exact?: boolean };

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const matchRoute = useMatchRoute();

  return (
    <aside
      className={cn(
        'app-sidebar hidden h-dvh flex-col text-sidebar-foreground transition-[width] duration-300 lg:flex',
        sidebarCollapsed ? 'w-[72px]' : 'w-[252px]',
      )}
    >
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
          S2
        </div>
        {!sidebarCollapsed && (
          <div className="min-w-0">
            <span className="block truncate text-sm font-semibold text-sidebar-foreground">toSub2</span>
            <span className="block truncate text-[11px] text-sidebar-foreground/55">账号池控制台</span>
          </div>
        )}
      </div>
      <Separator className="bg-sidebar-border" />
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="flex flex-col gap-5">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="flex flex-col gap-1">
              {!sidebarCollapsed && <span className="px-2 text-[11px] font-medium text-sidebar-foreground/45">{section.label}</span>}
              {section.items.map((item) => {
                const active = matchRoute({ to: item.to, fuzzy: !('exact' in item && item.exact) });
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      'flex h-10 items-center gap-3 rounded-md px-2.5 text-sm transition-colors',
                      active ? 'bg-sidebar-accent font-medium text-sidebar-foreground' : 'text-sidebar-foreground/72 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      sidebarCollapsed && 'justify-center px-0',
                    )}
                    title={item.label}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </ScrollArea>
      <div className="p-3">
        <Button variant="ghost" size="sm" className={cn('w-full text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground', sidebarCollapsed ? 'justify-center px-0' : 'justify-start')} onClick={toggleSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen data-icon="inline-start" /> : <PanelLeftClose data-icon="inline-start" />}
          {!sidebarCollapsed && '收起侧边栏'}
        </Button>
      </div>
    </aside>
  );
}
