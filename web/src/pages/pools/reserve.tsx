import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Inbox, Loader2, Pencil, RefreshCw, Search, Trash2, Upload, Download } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { download, errorMessage } from '@/api/client';
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
import { CredentialsEditDialog } from '@/components/credentials-edit-dialog';
import { FilterSelect } from '@/components/filter-select';
import { SortableHead, type SortState } from '@/components/sortable-head';
import { UploadOrderSelect, useOrderPreference } from '@/components/upload-order-select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/utils';

export function ReservePoolPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [forceDiscard, setForceDiscard] = useState(false);
  const [forceRemote, setForceRemote] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<ReserveAccount | null>(null);
  const [joinOrder, setJoinOrder] = useOrderPreference('pools.reserveJoinOrder');

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', 'reserve', { q, statusFilter, sort }],
    queryFn: () =>
      accountsApi.list<ReserveAccount>('reserve', {
        q: q || undefined,
        status: statusFilter || undefined,
        sort: sort ? `${sort.key}:${sort.dir}` : undefined,
        page_size: 200,
      }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'reserve'] });
    queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const importMutation = useMutation({
    mutationFn: ([text, twofaText, passwordsText]: [string, string, string]) =>
      accountsApi.import(text, twofaText, passwordsText, { force_discard: forceDiscard, force_remote: forceRemote }),
    onSuccess: (result) => {
      setImportResult(result);
      if (result.created > 0) {
        const mainCount = result.main_created ?? 0;
        const reserveCount = result.created - mainCount;
        const parts = [];
        if (mainCount > 0) parts.push(`${mainCount} 个账号直入主号池（含登录 tokens）`);
        if (reserveCount > 0) parts.push(`${reserveCount} 个账号已开始邮件初始化`);
        toast.success(parts.join('，'));
      }
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const joinMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.joinMain(ids, joinOrder || undefined),
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
  const selectedBalance = useMemo(
    () => items.filter((i) => selected.has(i.id) && i.has_balance).reduce((sum, i) => sum + (i.initial_balance ?? 0), 0),
    [items, selected],
  );

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
        <Badge variant="muted">
          总余额 ${(stats.total_balance ?? 0).toFixed(2)}
          <span className="ml-1 text-muted-foreground">（{stats.with_balance ?? 0} 个已知余额）</span>
        </Badge>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索邮箱…"
            className="h-6 w-56 pl-8"
          />
        </div>
        <FilterSelect
          value={statusFilter}
          onValueChange={setStatusFilter}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'mail_pending', label: '待初始化' },
            { value: 'mail_failed', label: '初始化失败' },
            { value: 'joining', label: '加入中' },
          ]}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => selected.size > 0 && refreshMailMutation.mutate(selectedIds)}
          disabled={selected.size === 0 || refreshMailMutation.isPending}
        >
          {refreshMailMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新邮件状态
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(
              selected.size > 0
                ? `/accounts/export?ids=${selectedIds.join(',')}&format=tosub2`
                : '/accounts/export?pool=reserve&format=tosub2',
              'tosub2-accounts.json',
            ).catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Download />
          {selected.size > 0 ? `导出所选 (${selected.size})` : '导出账号'}
        </Button>
        <Button size="sm" onClick={() => { setImportResult(null); setForceDiscard(false); setForceRemote(false); setImportOpen(true); }}>
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
                <SortableHead label="邮箱" sortKey="email" sort={sort} onSort={setSort} />
                <SortableHead label="初始余额" sortKey="balance" sort={sort} onSort={setSort} firstDir="desc" />
                <SortableHead label="封禁状态" sortKey="banned" sort={sort} onSort={setSort} />
                <SortableHead label="邮件状态" sortKey="mail_status" sort={sort} onSort={setSort} />
                <SortableHead label="导入时间" sortKey="imported_at" sort={sort} onSort={setSort} firstDir="desc" />
                <SortableHead label="检查时间" sortKey="last_checked_at" sort={sort} onSort={setSort} firstDir="desc" />
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
                    {account.has_password && (
                      <Badge variant="secondary" className="ml-2 py-0 font-sans">密码</Badge>
                    )}
                    {account.has_2fa && (
                      <Badge variant="info" className="ml-2 py-0 font-sans">2FA</Badge>
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
                      <Button size="sm" variant="ghost" onClick={() => setEditAccount(account)}>
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
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

      <BatchActionBar count={selected.size} onClear={() => setSelected(new Set())} extra={`合计余额 $${selectedBalance.toFixed(2)}`}>
        <UploadOrderSelect value={joinOrder} onValueChange={setJoinOrder} />
        <Button size="sm" onClick={() => joinMutation.mutate(selectedIds)} disabled={joinMutation.isPending}>
          {joinMutation.isPending && <Loader2 className="animate-spin" />}
          批量加入主号池
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            download(`/accounts/export?ids=${selectedIds.join(',')}&format=tosub2`, 'tosub2-accounts.json').catch((error) =>
              toast.error(errorMessage(error)),
            )
          }
        >
          <Download />
          导出账号
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
          批量删除
        </Button>
      </BatchActionBar>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="导入 Outlook 邮箱"
        placeholder={'邮箱----邮箱密码----clientId----refreshToken\n例：a@b.com----pass----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.C509_BL2...\n\n也可直接选择另一个 tosubV2 导出的账号 JSON 文件'}
        twofaPlaceholder={'邮箱----2FA取件码（只有开启两步验证的账号需要填）\n例：a@b.com----CBCLDAV22HRBZUDELLKNRPK4L3YJ25IQ'}
        passwordsPlaceholder={'ChatGPT 会话导出 JSON，密码在 meta.label 第 3 段；无密码账号可不管\n例：[{"meta":{"label":"a@b.com----xxxx----P@ssw0rd!"}}]'}
        result={importResult}
        busy={importMutation.isPending}
        onSubmit={(text, twofaText, passwordsText) => {
          if (importResult) {
            // 已有结果 → 点导入 = 带 force 重提交
            setForceDiscard(true);
            setForceRemote(true);
          }
          importMutation.mutate([text, twofaText, passwordsText]);
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

      <CredentialsEditDialog account={editAccount} open={!!editAccount} onOpenChange={(next) => !next && setEditAccount(null)} />

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
