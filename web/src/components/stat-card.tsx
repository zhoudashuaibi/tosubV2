import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  tone = 'default',
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="relative min-h-[116px] p-5">
        <div className="pr-12 text-xs text-muted-foreground">{title}</div>
        <div className="mt-2 font-mono text-[28px] font-medium leading-none tracking-[-0.02em]">{value}</div>
        {sub && <div className="mt-3 truncate text-xs text-muted-foreground/80">{sub}</div>}
        {Icon && (
          <div
            className={cn(
              'absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-md border',
              tone === 'success' && 'bg-[var(--success)]/15 text-[var(--success)]',
              tone === 'warning' && 'bg-[var(--warning)]/15 text-[var(--warning)]',
              tone === 'danger' && 'border-destructive/20 bg-destructive/15 text-destructive',
              tone === 'info' && 'border-primary/20 bg-primary/15 text-primary',
              tone === 'default' && 'bg-muted text-muted-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
