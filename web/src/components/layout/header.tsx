import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { authApi } from '@/api';
import { errorMessage } from '@/api/client';
import { Button } from '@/components/ui/button';
import { useUiStore } from '@/stores/ui';

export function Header({ title }: { title: string }) {
  const { theme, toggleTheme } = useUiStore();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = '/login';
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <header className="app-header z-20 px-3 pt-3 sm:px-6 lg:px-8">
      <div className="app-header-inner flex h-12 items-center justify-between rounded-lg border px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden h-2 w-2 shrink-0 rounded-full bg-[var(--success)] shadow-[0_0_12px_var(--success)] sm:block" />
          <h1 className="truncate text-[15px] font-medium tracking-normal">{title}</h1>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题" className="rounded-md">
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => logout.mutate()} title="退出登录" className="rounded-md">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}
