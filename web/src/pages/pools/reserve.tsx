import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Inbox, Loader2, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { ImportResult, ReserveAccount } from '@/api/types';
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
import { ImportDialog } from '@/components/import-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/utils';

export function ReservePoolPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [forceDiscard, setForceDiscard] = useState(false);
  const [forceRemote, setForceRemote] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', 'reserve', { q, statusFilter }],
    queryFn: () =>
      accountsApi.list<ReserveAccount>('reserve', {
        q: q || undefined,
        status: statusFilter || undefined,
        page_size: 200,
      }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'reserve'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const importMutation = useMutation({
    mutationFn: (text: string) => accountsApi.import(text, { force_discard: forceDiscard, force_remote: forceRemote }),
    onSuccess: (result) => {
      setImportResult(result);
      if (result.created > 0) toast.success(`已开始 ${result.created} 个账号的邮件初始化，稍后刷新查看余额与状态`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const joinMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.joinMain(ids),
    onSuccess: (result) => {
      toast.success(`已发起 ${result.started.length} 个账号加入主号池`);
      for (const skip of result.skipped) toast.warning(`账号 ${skip.id} 跳过：${skip.reason}`);
      setSelected(new Set());
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const refreshMailMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => accountsApi.refreshMail(id))),
    onSuccess: () => {
      toast.success('已开始重新拉取邮件');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchDelete(ids),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 个账号`);
      setSelected(new Set());
      setDeleteOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = data?.items ?? [];
  const selectedIds = useMemo(() => [...selected], [selected]);
  const stats = data?.stats ?? {};

  const toggleAll = () => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="muted">总数 {data?.total ?? 0}</Badge>
        <Badge variant="success">可用 {stats.banned !== undefined ? (data?.total ?? 0) - (stats.banned ?? 0) - (stats.joining ?? 0) : '—'}</Badge>
        <Badge variant="danger">已封禁 {stats.banned ?? 0}</Badge>
        <Badge variant="info">加入中 {stats.joining ?? 0}</Badge>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索邮箱…"
            className="w-56 pl-8"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">全部状态</option>
          <option value="mail_pending">待初始化</option>
          <option value="mail_failed">初始化失败</option>
          <option value="joining">加入中</option>
        </select>
        <Button
          variant="outline"
          onClick={() => selected.size > 0 && refreshMailMutation.mutate(selectedIds)}
          disabled={selected.size === 0 || refreshMailMutation.isPending}
        >
          {refreshMailMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新邮件状态
        </Button>
        <Button onClick={() => { setImportResult(null); setForceDiscard(false); setForceRemote(false); setImportOpen(true); }}>
          <Upload />
          导入邮箱
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="备用号池为空"
            description="导入 Outlook 邮箱账号（邮箱----密码----clientId----refresh_token），系统将自动初始化余额与封禁状态"
            actionLabel="导入第一批邮箱"
            onAction={() => setImportOpen(true)}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={selected.size === items.length} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>初始余额</TableHead>
                <TableHead>封禁状态</TableHead>
                <TableHead>邮件状态</TableHead>
                <TableHead>导入时间</TableHead>
                <TableHead>检查时间</TableHead>
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
                  <TableCell className="max-w-[240px] truncate font-mono text-xs">
                    {account.banned ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help text-destructive">🔒 {account.email}</span>
                        </TooltipTrigger>
                        <TooltipContent>{account.banned_reason ?? '已封禁'}</TooltipContent>
                      </Tooltip>
                    ) : (
                      account.email
                    )}
                    {account.status === 'joining' && (
                      <Link to="/jobs" className="ml-2 text-xs text-primary hover:underline">
                        查看任务 →
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>
                    <BalanceTag value={account.has_balance ? account.initial_balance : null} />
                  </TableCell>
                  <TableCell>
                    {account.banned ? <Badge variant="danger">已封禁</Badge> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <MailStatusBadge account={account} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.imported_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.last_checked_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={account.banned || account.status === 'joining'}
                        onClick={() => joinMutation.mutate([account.id])}
                      >
                        加入主号池
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => refreshMailMutation.mutate([account.id])}>
                        重新检查
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
                        删除
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
        <Button size="sm" onClick={() => joinMutation.mutate(selectedIds)} disabled={joinMutation.isPending}>
          {joinMutation.isPending && <Loader2 className="animate-spin" />}
          批量加入主号池
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
          批量删除
        </Button>
      </BatchActionBar>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="导入 Outlook 邮箱"
        placeholder={'邮箱----邮箱密码----clientId----refreshToken\n例：a@b.com----pass----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.C509_BL2...'}
        result={importResult}
        busy={importMutation.isPending}
        onSubmit={(text) => {
          if (importResult) {
            // 已有结果 → 点导入 = 带 force 重提交
            setForceDiscard(true);
            setForceRemote(true);
          }
          importMutation.mutate(text);
        }}
      />
      {importResult && (importResult.duplicates_in_discard.length > 0 || importResult.duplicates_remote.length > 0) && (
        <div className="flex items-center gap-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm">
          <span className="flex-1">存在废弃池/远端重复账号，点击「导入」按钮将强制重新导入这些账号。</span>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            查看详情
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除 ${selected.size} 个账号？`}
        description="将同时删除账号凭据、断点与产物文件，操作不可恢复。"
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />
    </div>
  );
}

function MailStatusBadge({ account }: { account: ReserveAccount }) {
  if (account.mail_status === 'checking') {
    return (
      <Badge variant="info">
        <Loader2 className="h-3 w-3 animate-spin" /> 检查中
      </Badge>
    );
  }
  if (account.mail_status === 'ok') return <Badge variant="success">正常</Badge>;
  if (account.mail_status === 'fetch_failed') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="danger">取件失败</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{account.mail_error ?? '未知错误'}</TooltipContent>
      </Tooltip>
    );
  }
  return <Badge variant="muted">待检查</Badge>;
}
