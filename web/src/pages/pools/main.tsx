import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, CloudDownload, Coins, Download, KeyRound, Loader2, Plus, RefreshCw, Search, Trash2, Upload, Users } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi, sub2apiApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import type { MainAccount, Sub2ApiConfigView, UploadOptions, UploadOrder } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { BalanceTag } from '@/components/balance-tag';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { FilterSelect } from '@/components/filter-select';
import { SortableHead, type SortState } from '@/components/sortable-head';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UploadOrderSelect, useOrderPreference } from '@/components/upload-order-select';
import { formatRelativeTime } from '@/lib/utils';

export function MainPoolPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [remoteFilter, setRemoteFilter] = useState('');
  const [uploadedOnly, setUploadedOnly] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', 'main', { q, statusFilter, remoteFilter, uploadedOnly, sort }],
    queryFn: () =>
      accountsApi.list<MainAccount>('main', {
        q: q || undefined,
        status: statusFilter || undefined,
        remote_status: remoteFilter || undefined,
        uploaded: uploadedOnly ? 'true' : undefined,
        sort: sort ? `${sort.key}:${sort.dir}` : undefined,
        page_size: 200,
      }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const authorizeMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchAuthorize(ids),
    onSuccess: (result) => {
      toast.success(`已发起 ${result.started} 个账号的授权任务`);
      for (const skip of result.skipped) toast.warning(`账号 ${skip.id} 跳过：${skip.reason}`);
      setSelected(new Set());
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const balanceMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchRefreshBalance(ids),
    onSuccess: (result) => {
      toast.success(`已发起 ${result.started} 个余额查询任务`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const syncRemoteMutation = useMutation({
    mutationFn: () => sub2apiApi.syncRemote(),
    onSuccess: (result) => {
      const parts = [`新关联 ${result.linked}`, `状态更新 ${result.status_updated}`];
      if (result.unlinked) parts.push(`解除 ${result.unlinked}`);
      toast.success(`远端同步完成（扫描 ${result.scanned}）：${parts.join('，')}`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const discardMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchDiscard(ids),
    onSuccess: (result) => {
      toast.success(`已废弃 ${result.discarded} 个账号`);
      setSelected(new Set());
      setDiscardOpen(false);
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

  const uploadMutation = useMutation({
    mutationFn: ({ ids, options, order }: { ids: number[]; options?: UploadOptions; order?: UploadOrder }) =>
      accountsApi.batchUpload(ids, options, order),
    onSuccess: (result) => {
      toast.success(`上传完成：新增 ${result.created}，替换 ${result.updated}` + (result.failed.length ? `，失败 ${result.failed.length}` : ''));
      if (result.failed.length) {
        toast.error(result.failed.map((f) => `${f.email ?? f.id}: ${f.error}`).slice(0, 3).join('\n'), { duration: 8000 });
      }
      setSelected(new Set());
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'monitor'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = data?.items ?? [];
  const selectedIds = useMemo(() => [...selected], [selected]);
  const selectedBalance = items.filter((i) => selected.has(i.id)).reduce((sum, i) => sum + (i.balance ?? 0), 0);
  const stats = data?.stats ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { value: 'active', label: '可用', variant: 'success' },
            { value: 'authorizing', label: '授权中', variant: 'info' },
            { value: 'needs_reauth', label: '待重授', variant: 'warning' },
          ] as const
        ).map((chip) => (
          <button
            key={chip.value}
            type="button"
            aria-pressed={statusFilter === chip.value}
            className="cursor-pointer rounded-full focus-visible:outline-none"
            onClick={() => setStatusFilter((prev) => (prev === chip.value ? '' : chip.value))}
          >
            <Badge
              variant={chip.variant}
              className={
                statusFilter === chip.value
                  ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                  : 'opacity-80 hover:opacity-100'
              }
            >
              {chip.label} {stats[chip.value] ?? 0}
            </Badge>
          </button>
        ))}
        <Badge variant="muted">总余额 ${(stats.total_balance ?? 0).toFixed?.(2) ?? stats.total_balance ?? '0.00'}</Badge>
        <button
          type="button"
          aria-pressed={uploadedOnly}
          className="cursor-pointer rounded-full focus-visible:outline-none"
          onClick={() => setUploadedOnly((prev) => !prev)}
        >
          <Badge
            variant="secondary"
            className={
              uploadedOnly
                ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                : 'opacity-80 hover:opacity-100'
            }
          >
            已上传 {stats.uploaded ?? 0}
          </Badge>
        </button>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索邮箱…" className="h-6 w-56 pl-8" />
        </div>
        <FilterSelect
          value={statusFilter}
          onValueChange={setStatusFilter}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'active', label: '可用' },
            { value: 'authorizing', label: '授权中' },
            { value: 'needs_reauth', label: '待重新授权' },
          ]}
        />
        <FilterSelect
          value={remoteFilter}
          onValueChange={setRemoteFilter}
          label="全部远端"
          className="w-[132px]"
          options={[
            { value: 'active', label: '远端可用' },
            { value: 'abnormal', label: '远端异常' },
            { value: 'not_uploaded', label: '未上传' },
          ]}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={syncRemoteMutation.isPending}
          onClick={() => syncRemoteMutation.mutate()}
        >
          {syncRemoteMutation.isPending ? <Loader2 className="animate-spin" /> : <CloudDownload />}
          同步远端
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus />
          添加账号
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(
              selected.size > 0
                ? `/accounts/export?ids=${selectedIds.join(',')}&format=tosub2`
                : '/accounts/export?pool=main&format=tosub2',
              'tosub2-accounts.json',
            ).catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Download />
          {selected.size > 0 ? `导出所选 (${selected.size})` : '导出账号'}
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
            icon={Users}
            title={statusFilter || remoteFilter || uploadedOnly ? '没有符合条件的账号' : '主号池为空'}
            description={
              statusFilter || remoteFilter || uploadedOnly
                ? '换个条件试试，或点击当前高亮的徽章取消筛选'
                : '从备用号池「加入主号池」完成邮箱验证码登录，或手动添加账号'
            }
          />
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
                <SortableHead label="邮箱" sortKey="email" sort={sort} onSort={setSort} />
                <SortableHead label="状态" sortKey="status" sort={sort} onSort={setSort} />
                <SortableHead label="余额" sortKey="balance" sort={sort} onSort={setSort} firstDir="desc" />
                <SortableHead label="远端状态" sortKey="remote_status" sort={sort} onSort={setSort} />
                <SortableHead label="上传时间" sortKey="sub2api_uploaded_at" sort={sort} onSort={setSort} firstDir="desc" />
                <SortableHead label="最近登录" sortKey="last_login_at" sort={sort} onSort={setSort} firstDir="desc" />
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
                    {account.status === 'needs_reauth' && <span className="mr-1 text-[var(--warning)]">⚠</span>}
                    {account.email}
                    {account.has_password && <Badge variant="secondary" className="ml-2 py-0 font-sans">密码</Badge>}
                    {account.has_2fa && <Badge variant="info" className="ml-2 py-0 font-sans">2FA</Badge>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge domain="main" value={account.status} />
                  </TableCell>
                  <TableCell>
                    <BalanceTag value={account.balance} checkedAt={account.balance_checked_at} error={account.balance_error} />
                  </TableCell>
                  <TableCell>
                    {account.sub2api_account_id ? (
                      account.remote_status === 'active' ? (
                        <Badge variant="success">● active</Badge>
                      ) : (
                        <Badge variant="danger">● {account.remote_status}</Badge>
                      )
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.sub2api_uploaded_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.last_login_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => { setSelected(new Set([account.id])); setUploadOpen(true); }}>
                        上传
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={account.status === 'authorizing'}
                        onClick={() => authorizeMutation.mutate([account.id])}
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        重新授权
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => balanceMutation.mutate([account.id])}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        查余额
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => { setSelected(new Set([account.id])); setDiscardOpen(true); }}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <BatchActionBar
        count={selected.size}
        extra={`合计余额 $${selectedBalance.toFixed(2)}`}
        onClear={() => setSelected(new Set())}
      >
        <Button size="sm" onClick={() => authorizeMutation.mutate(selectedIds)} disabled={authorizeMutation.isPending}>
          {authorizeMutation.isPending && <Loader2 className="animate-spin" />}
          批量授权
        </Button>
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload />
          批量上传 sub2api
        </Button>
        <Button size="sm" variant="outline" onClick={() => balanceMutation.mutate(selectedIds)}>
          <Coins />
          批量获取余额
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => download(`/accounts/export?ids=${selectedIds.join(',')}&format=sub2api`, 'sub2api-import.json')}
        >
          导出(sub2api)
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => download(`/accounts/export?ids=${selectedIds.join(',')}&format=source`, 'accounts-source.txt')}
        >
          导出(原始资料)
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDiscardOpen(true)}>
          批量废弃
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteOpen(true)}>
          <Trash2 />
        </Button>
      </BatchActionBar>

      <UploadConfigDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        count={selected.size}
        busy={uploadMutation.isPending}
        onUpload={(options, order) => uploadMutation.mutate({ ids: selectedIds, options, order })}
      />

      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={`废弃 ${selected.size} 个账号？`}
        description="账号将移入废弃号池并记录原因，可随时移回主号池。"
        confirmText="废弃"
        busy={discardMutation.isPending}
        onConfirm={() => discardMutation.mutate(selectedIds)}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除 ${selected.size} 个账号？`}
        description="将同时删除凭据、断点与产物文件，操作不可恢复。"
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />
    </div>
  );
}

function UploadConfigDialog({
  open,
  onOpenChange,
  count,
  busy,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  busy: boolean;
  onUpload: (options: UploadOptions, order?: UploadOrder) => void;
}) {
  const { data: config } = useQuery({
    queryKey: ['sub2api', 'config'],
    queryFn: () => sub2apiApi.config(),
    enabled: open,
  });
  const { data: groups } = useQuery({
    queryKey: ['sub2api', 'groups'],
    queryFn: () => sub2apiApi.groups(),
    enabled: open,
    retry: false,
  });
  const { data: remoteProxies } = useQuery({
    queryKey: ['sub2api', 'proxies'],
    queryFn: () => sub2apiApi.proxies(),
    enabled: open,
    retry: false,
  });

  const defaults = config?.upload_defaults ?? {};
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [concurrency, setConcurrency] = useState('');
  const [loadFactor, setLoadFactor] = useState('');
  const [priority, setPriority] = useState('');
  const [modelWhitelist, setModelWhitelist] = useState('');
  const [autoSelectProxy, setAutoSelectProxy] = useState(true);
  const [proxyId, setProxyId] = useState('');
  const [disable5h, setDisable5h] = useState(false);
  const [disable7d, setDisable7d] = useState(false);
  const [longContextBilling, setLongContextBilling] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [order, setOrder] = useOrderPreference('pools.mainUploadOrder');

  useEffect(() => {
    if (open && config && !loaded) {
      setGroupIds(config.group_ids ?? []);
      setDisable5h(Boolean(defaults.disable_auto_pause_5h));
      setDisable7d(Boolean(defaults.disable_auto_pause_7d));
      setLongContextBilling(defaults.enable_long_context_billing !== false);
      setAutoSelectProxy(defaults.auto_select_proxy !== false);
      setConcurrency(defaults.concurrency != null ? String(defaults.concurrency) : '');
      setLoadFactor(defaults.load_factor != null ? String(defaults.load_factor) : '');
      setPriority(defaults.priority != null ? String(defaults.priority) : '');
      setModelWhitelist((defaults.model_whitelist ?? []).join(', '));
      setProxyId(defaults.proxy_id != null ? String(defaults.proxy_id) : '');
      setLoaded(true);
    }
    if (!open) setLoaded(false);
  }, [open, config, defaults, loaded]);

  if (open && config && !config.base_url) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>尚未配置 sub2api</DialogTitle>
            <DialogDescription>请先完成 sub2api 连接配置后再上传账号。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button asChild>
              <Link to="/sub2api">前去配置</Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>上传 {count} 个账号到 sub2api</DialogTitle>
          <DialogDescription>已存在的账号将替换凭据，不存在的将新增</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label>分组（留空 = 默认分组）</Label>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
              {(groups?.items ?? []).length === 0 && <span className="text-xs text-muted-foreground">无可用分组（或连接未配置）</span>}
              {(groups?.items ?? []).map((group) => (
                <label key={group.id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={groupIds.includes(group.id)}
                    onCheckedChange={() =>
                      setGroupIds((prev) => (prev.includes(group.id) ? prev.filter((g) => g !== group.id) : [...prev, group.id]))
                    }
                  />
                  {group.name} (#{group.id})
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>上传顺序</Label>
            <UploadOrderSelect value={order} onValueChange={setOrder} size="default" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>并发数（留空保留原值）</Label>
              <Input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} placeholder="10" />
            </div>
            <div className="space-y-1.5">
              <Label>负载因子</Label>
              <Input value={loadFactor} onChange={(e) => setLoadFactor(e.target.value)} placeholder="1" />
            </div>
            <div className="space-y-1.5">
              <Label>优先级（留空按余额分档）</Label>
              <Input value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="余额分档" />
              <p className="text-xs text-muted-foreground">留空时：&lt;10 刀 → 40，10-20 刀 → 20，20-40 刀 → 30，≥40 刀 → 10</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>模型白名单（逗号分隔，留空不限制）</Label>
            <Input value={modelWhitelist} onChange={(e) => setModelWhitelist(e.target.value)} placeholder="gpt-5, gpt-5-mini" />
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={autoSelectProxy} onCheckedChange={setAutoSelectProxy} />
              自动绑定 sub2api 内绑定数最少的代理
            </label>
            {!autoSelectProxy && (
              <Select value={proxyId || '__none__'} onValueChange={(value) => setProxyId(value === '__none__' ? '' : value)}>
                <SelectTrigger className="w-full" aria-label="指定上传代理">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__none__">不指定代理</SelectItem>
                    {(remoteProxies?.items ?? []).map((proxy) => (
                      <SelectItem key={proxy.id} value={String(proxy.id)}>
                        #{proxy.id} {proxy.name} ({proxy.host}:{proxy.port})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={disable5h} onCheckedChange={setDisable5h} />
              禁用 5h 自动暂停
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={disable7d} onCheckedChange={setDisable7d} />
              禁用 7d 自动暂停
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={longContextBilling} onCheckedChange={setLongContextBilling} />
              API 长上下文计费
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              onUpload({
                group_ids: groupIds,
                concurrency: concurrency === '' ? null : Number(concurrency),
                load_factor: loadFactor === '' ? null : Number(loadFactor),
                priority: priority === '' ? null : Number(priority),
                model_whitelist: modelWhitelist
                  .split(',')
                  .map((m) => m.trim())
                  .filter(Boolean),
                auto_select_proxy: autoSelectProxy,
                proxy_id: proxyId ? Number(proxyId) : null,
                disable_auto_pause_5h: disable5h,
                disable_auto_pause_7d: disable7d,
                enable_long_context_billing: longContextBilling,
              }, order || undefined)
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            上传
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mailApiUrl, setMailApiUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpPickupCode, setTotpPickupCode] = useState('');
  const [outlookPassword, setOutlookPassword] = useState('');
  const [outlookClientId, setOutlookClientId] = useState('');
  const [outlookRefreshToken, setOutlookRefreshToken] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { email };
      if (password) body.password = password;
      if (mailApiUrl) body.mail_api_url = mailApiUrl;
      if (totpSecret) body.totp_secret = totpSecret;
      if (totpPickupCode) body.totp_pickup_code = totpPickupCode;
      if (outlookRefreshToken) {
        body.outlook = {
          password: outlookPassword,
          client_id: outlookClientId,
          refresh_token: outlookRefreshToken,
        };
      }
      return accountsApi.create(body);
    },
    onSuccess: (result) => {
      toast.success(`账号已创建，登录任务已发起（${result.job_id.slice(0, 8)}…）`);
      onOpenChange(false);
      setEmail('');
      setPassword('');
      setMailApiUrl('');
      setTotpSecret('');
      setTotpPickupCode('');
      setOutlookPassword('');
      setOutlookClientId('');
      setOutlookRefreshToken('');
      queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>手动添加账号（进主号池）</DialogTitle>
          <DialogDescription>至少提供一项凭据；创建后自动发起登录任务</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>邮箱 *</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@b.com" />
          </div>
          <div className="space-y-1.5">
            <Label>登录密码</Label>
            <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="（可选）" />
          </div>
          <div className="space-y-1.5">
            <Label>收码 API 地址</Label>
            <Input value={mailApiUrl} onChange={(e) => setMailApiUrl(e.target.value)} placeholder="（可选）https://…" />
          </div>
          <div className="space-y-1.5">
            <Label>2FA 密钥（Base32）</Label>
            <Input value={totpSecret} onChange={(e) => setTotpSecret(e.target.value)} placeholder="（可选）" />
          </div>
          <div className="space-y-1.5">
            <Label>2FA 取件码（在线取码，如 2fa.show）</Label>
            <Input value={totpPickupCode} onChange={(e) => setTotpPickupCode(e.target.value)} placeholder="（可选）CBCLDAV22HRBZUDELLKNRPK4L3YJ25IQ" />
          </div>
          <div className="space-y-1.5 rounded-md border p-3">
            <Label className="text-muted-foreground">Outlook 凭据（可选，用于自动收码）</Label>
            <Input value={outlookPassword} onChange={(e) => setOutlookPassword(e.target.value)} placeholder="邮箱密码" className="mt-2" />
            <Input value={outlookClientId} onChange={(e) => setOutlookClientId(e.target.value)} placeholder="clientId (UUID)" className="mt-2" />
            <Input value={outlookRefreshToken} onChange={(e) => setOutlookRefreshToken(e.target.value)} placeholder="refresh_token" className="mt-2" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !email.includes('@')}>
            {create.isPending && <Loader2 className="animate-spin" />}
            创建并登录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
