import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { DiscardAccount } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { BalanceTag } from '@/components/balance-tag';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/utils';

const REASON_LABELS: Record<string, string> = {
  banned_401: '封禁(401)',
  rate_limited_429: '限流(429)',
  repair_failed: '修复失败',
  login_failed: '登录封禁',
  manual: '手动废弃',
};

export function DiscardPoolPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', 'discard', { q }],
    queryFn: () => accountsApi.list<DiscardAccount>('discard', { q: q || undefined, page_size: 200 }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'discard'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const restoreMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => accountsApi.restore(id))),
    onSuccess: () => {
      toast.success('已移回主号池（待重新授权状态）');
      setSelected(new Set());
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchDelete(ids),
    onSuccess: (result) => {
      toast.success(`已彻底删除 ${result.deleted} 个账号`);
      setSelected(new Set());
      setDeleteOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = data?.items ?? [];
  const selectedIds = useMemo(() => [...selected], [selected]);
  const stats = data?.stats ?? {};

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground">
        移回主号池后账号为「待重新授权」状态，建议先批量授权再上传。
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="danger">封禁(401) {stats.banned_401 ?? 0}</Badge>
        <Badge variant="warning">限流(429) {stats.rate_limited_429 ?? 0}</Badge>
        <Badge variant="warning">修复失败 {stats.repair_failed ?? 0}</Badge>
        <Badge variant="muted">手动废弃 {stats.manual ?? 0}</Badge>
        <div className="flex-1" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索邮箱…" className="w-56" />
      </div>

      <div className="rounded-lg border bg-card">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={Archive} title="废弃号池为空" description="被 sub2api 监控判定 401/429 或手动废弃的账号会出现在这里" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selected.size === items.length}
                    onCheckedChange={() =>
                      setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))))
                    }
                  />
                </TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>废弃原因</TableHead>
                <TableHead>详情</TableHead>
                <TableHead>废弃时余额</TableHead>
                <TableHead>废弃时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((account) => (
                <TableRow key={account.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(account.id)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(account.id)) next.delete(account.id);
                          else next.add(account.id);
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate font-mono text-xs">{account.email}</TableCell>
                  <TableCell>
                    <StatusBadge domain="discard" value={account.discard_reason} />
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    {account.discard_detail ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help truncate text-xs text-muted-foreground underline decoration-dotted">
                            {account.discard_detail.slice(0, 60)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md whitespace-pre-wrap">{account.discard_detail}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <BalanceTag value={account.balance} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.discarded_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => restoreMutation.mutate([account.id])}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        移回主号池
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => {
                          setSelected(new Set([account.id]));
                          setDeleteOpen(true);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <BatchActionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" onClick={() => restoreMutation.mutate(selectedIds)}>
          批量移回主号池
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
          批量彻底删除
        </Button>
      </BatchActionBar>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`彻底删除 ${selected.size} 个账号？`}
        description="将同时删除凭据、断点与产物文件，操作不可恢复。"
        confirmText="彻底删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />
    </div>
  );
}
