import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRightLeft,
  Globe,
  Loader2,
  Pencil,
  Play,
  Save,
  Search,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { proxiesApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { MergedProxyReplaceResult, Proxy, ProxyImportResult, ProxyPatrolLog } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ImportDialog } from '@/components/import-dialog';
import { FilterSelect } from '@/components/filter-select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';

const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h'];

export function ProxiesPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ProxyImportResult | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['proxies', { q, statusFilter }],
    queryFn: () => proxiesApi.list({ q: q || undefined, status: statusFilter || undefined, page_size: 500 }),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((p) => p.status === 'testing') ? 3000 : 30000;
    },
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['proxies'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const importMutation = useMutation({
    mutationFn: (text: string) => proxiesApi.import(text),
    onSuccess: (result) => {
      setImportResult(result);
      setImportedCount(result.created);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const testMutation = useMutation({
    mutationFn: (ids?: number[]) => proxiesApi.test(ids?.length ? ids : undefined),
    onSuccess: (result) => {
      toast.success(`已开始测试 ${result.started} 条代理，结果稍后刷新`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const labelMutation = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) => proxiesApi.updateLabel(id, label),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => proxiesApi.batchRemove(ids),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 条代理`);
      setSelected(new Set());
      setDeleteOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = data?.items ?? [];
  const stats = data?.stats ?? {};
  const selectedIds = useMemo(() => [...selected], [selected]);
  const testing = items.filter((i) => i.status === 'testing').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">可用 {stats.alive ?? 0}</Badge>
        <Badge variant="danger">失效 {stats.dead ?? 0}</Badge>
        <Badge variant="warning">CF拦截 {stats.cf_challenge ?? 0}</Badge>
        <Badge variant="muted">未测 {stats.unknown ?? 0}</Badge>
        {testing > 0 && <Badge variant="info"><Loader2 className="h-3 w-3 animate-spin" /> 测试中 {testing}</Badge>}
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索代理/备注…" className="h-6 w-52 pl-8" />
        </div>
        <FilterSelect
          value={statusFilter}
          onValueChange={setStatusFilter}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'alive', label: '可用' },
            { value: 'dead', label: '失效' },
            { value: 'cf_challenge', label: '被 CF 拦截' },
            { value: 'unknown', label: '未测' },
          ]}
        />
        <Button variant="outline" size="sm" onClick={() => testMutation.mutate(undefined)} disabled={testMutation.isPending}>
          <Activity />
          测试全部连通性
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setReplaceOpen(true);
          }}
        >
          <ArrowRightLeft />
          一键更换 IP
        </Button>
        <Button size="sm" onClick={() => { setImportResult(null); setImportOpen(true); }}>
          <Upload />
          批量导入
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="代理列表为空"
            description="批量导入代理后一键测活，所有 OpenAI 请求将随机选用存活代理，无可用时回退本机直连"
            actionLabel="导入第一批代理"
            onAction={() => setImportOpen(true)}
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
                <TableHead>代理</TableHead>
                <TableHead>备注</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>延迟</TableHead>
                <TableHead>最近检测</TableHead>
                <TableHead>失败计数</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((proxy) => (
                <TableRow key={proxy.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(proxy.id)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(proxy.id)) next.delete(proxy.id);
                          else next.add(proxy.id);
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate font-mono text-xs">
                    {proxy.display_url}
                    {proxy.rotatable && <span className="ml-1.5 text-[10px] text-primary">可轮换</span>}
                  </TableCell>
                  <TableCell>
                    {editingId === proxy.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="h-7 w-28 text-xs"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') labelMutation.mutate({ id: proxy.id, label: editLabel });
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Button size="sm" variant="ghost" onClick={() => labelMutation.mutate({ id: proxy.id, label: editLabel })}>
                          保存
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{proxy.label ?? '—'}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{proxy.protocol}</TableCell>
                  <TableCell>
                    <StatusBadge domain="proxy" value={proxy.status} tooltip={proxy.last_error} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {proxy.last_latency_ms !== null && proxy.status !== 'dead' ? `${proxy.last_latency_ms}ms` : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(proxy.last_checked_at)}</TableCell>
                  <TableCell>
                    {proxy.fail_count > 0 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help font-mono text-xs text-destructive">{proxy.fail_count}</span>
                        </TooltipTrigger>
                        <TooltipContent>任务运行中的连接失败累计，达到阈值自动置为失效</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="font-mono text-xs">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => testMutation.mutate([proxy.id])}>
                        <Zap className="h-3.5 w-3.5" />
                        测试
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(proxy.id);
                          setEditLabel(proxy.label ?? '');
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => {
                          setSelected(new Set([proxy.id]));
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
        <Button size="sm" variant="outline" onClick={() => testMutation.mutate(selectedIds)}>
          <Activity />
          测试选中
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
          删除选中
        </Button>
      </BatchActionBar>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="批量导入代理"
        placeholder={'http://user:pass@host:port----备注（可选）\nsocks5h://user:pass@host:1080'}
        result={importResult}
        busy={importMutation.isPending}
        onSubmit={(text) => importMutation.mutate(text)}
      />
      {importedCount > 0 && !importOpen && (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
          <span className="flex-1">刚导入了 {importedCount} 条代理，要立即测试连通性吗？</span>
          <Button
            size="sm"
            onClick={() => {
              testMutation.mutate(undefined);
              setImportedCount(0);
            }}
          >
            立即测试
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除 ${selected.size} 条代理？`}
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />

      <ReplaceIpsDialog open={replaceOpen} onOpenChange={setReplaceOpen} />

      <PatrolCard />
    </div>
  );
}

/** 一键更换 IP（合并入口）：一次粘贴 → sub2api 替换（socks5）+ 本机代理列表换批导入（socks5h） */
function ReplaceIpsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [sub2apiProtocol, setSub2apiProtocol] = useState('socks5');
  const [localProtocol, setLocalProtocol] = useState('socks5h');
  const [syncSub2api, setSyncSub2api] = useState(true);
  const [deleteOld, setDeleteOld] = useState(true);
  const [deleteOldLocal, setDeleteOldLocal] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<MergedProxyReplaceResult | null>(null);

  const replaceMutation = useMutation({
    mutationFn: () =>
      proxiesApi.replaceIps({
        text,
        sub2api_protocol: sub2apiProtocol,
        local_protocol: localProtocol,
        sync_sub2api: syncSub2api,
        delete_old: deleteOld,
        delete_old_local: deleteOldLocal,
      }),
    onSuccess: (data) => {
      setResult(data);
      setConfirming(false);
      const sub2api = data.sub2api;
      const summary =
        (sub2api
          ? `sub2api：新建 ${sub2api.created.length} · 复用 ${sub2api.reused.length} · 改绑账号 ${sub2api.rebound.total} · 删旧 ${sub2api.old_proxies.deleted}`
          : `sub2api：已跳过（${data.sub2api_skipped_reason}）`) +
        `；本机：导入 ${data.local.imported} · 删旧 ${data.local.removed}`;
      const problems =
        data.local.invalid_lines.length +
        (sub2api ? sub2api.create_failed.length + sub2api.rebound.failed_groups.length + sub2api.old_proxies.skipped.length : 0);
      if (problems > 0) toast.warning(summary);
      else toast.success(summary);
      queryClient.invalidateQueries({ queryKey: ['proxies'] });
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'proxies'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(errorMessage(error));
    },
  });

  const busy = replaceMutation.isPending;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          onOpenChange(next);
          if (!next) {
            setText('');
            setResult(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>一键更换代理 IP</DialogTitle>
            <DialogDescription>
              每行一条，格式 ip:端口:用户名:密码（无认证可只写 ip:端口），支持 # 注释行。同一次粘贴将双写：
              sub2api 按所选协议替换并改绑账号，本机代理列表按本机协议导入换批
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'198.23.128.39:5667:cxzoljuy:cefn2yq3q0vn\n198.23.128.40:5667:cxzoljuy:cefn2yq3q0vn'}
              className="min-h-[160px] font-mono text-xs"
              spellCheck={false}
              disabled={busy}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>sub2api 协议</Label>
                <Select value={sub2apiProtocol} onValueChange={setSub2apiProtocol} disabled={busy}>
                  <SelectTrigger aria-label="sub2api 协议">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {PROXY_PROTOCOLS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>本机协议</Label>
                <Select value={localProtocol} onValueChange={setLocalProtocol} disabled={busy}>
                  <SelectTrigger aria-label="本机协议">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {PROXY_PROTOCOLS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={syncSub2api} onCheckedChange={setSyncSub2api} disabled={busy} />
                同步到 sub2api（未配置时自动跳过，仅做本机导入）
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={deleteOld} onCheckedChange={setDeleteOld} disabled={busy || !syncSub2api} />
                改绑完成后删除 sub2api 旧代理
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={deleteOldLocal} onCheckedChange={setDeleteOldLocal} disabled={busy} />
                删除本机列表中不在本次输入内的旧代理
              </label>
            </div>
            {result && <MergedReplaceResultView result={result} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              关闭
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={busy || !text.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              开始更换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="确认一键更换代理 IP？"
        description={
          syncSub2api
            ? '将在 sub2api 创建新代理（名字自动续接编号），把绑定在现有代理上的账号随机改绑到新代理，并按开关删除两侧旧代理；本机列表同时按所选协议导入换批。此操作不可撤销。'
            : '仅本机操作：按所选协议导入新代理，并按开关删除本机列表中不在本次输入内的旧代理。此操作不可撤销。'
        }
        confirmText="确认更换"
        onConfirm={() => replaceMutation.mutate()}
        busy={busy}
      />
    </>
  );
}

function MergedReplaceResultView({ result }: { result: MergedProxyReplaceResult }) {
  const sub2api = result.sub2api;
  const problems = [
    ...(sub2api
      ? [
          ...sub2api.create_failed.map((item) => `sub2api 创建失败 ${item.proxy}：${item.reason}`),
          ...sub2api.rebound.failed_groups.map((g) => `sub2api 改绑失败 ${g.name || `#${g.proxy_id}`}（${g.count} 个账号）：${g.reason}`),
          ...sub2api.old_proxies.skipped.map((item) => `sub2api 旧代理 #${item.id} ${item.name} 未删除：${item.reason}`),
          ...sub2api.invalid_lines.map((item) => `第 ${item.line} 行：${item.reason}`),
        ]
      : []),
    ...result.local.invalid_lines.map((item) => `本机导入失败 ${item.reason}`),
  ];
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      {sub2api ? (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>sub2api 新建 {sub2api.created.length}（编号 {sub2api.name_start} 起）</span>
            <span>复用 {sub2api.reused.length}</span>
            {sub2api.duplicates_in_input > 0 && <span>输入重复 {sub2api.duplicates_in_input}</span>}
            <span>改绑账号 {sub2api.rebound.total}</span>
            <span>删旧代理 {sub2api.old_proxies.deleted}</span>
          </div>
          {sub2api.rebound.groups.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {sub2api.rebound.groups.map((group) => (
                <span key={group.proxy_id}>
                  {group.name || `#${group.proxy_id}`} × {group.count}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-muted-foreground">sub2api：{result.sub2api_skipped_reason}</div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>本机导入 {result.local.imported}（{result.local.protocol}）</span>
        {result.local.duplicates.length > 0 && <span>本机已存在 {result.local.duplicates.length}</span>}
        <span>本机删旧 {result.local.removed}</span>
      </div>
      {problems.length > 0 && (
        <div className="space-y-1 text-xs text-destructive">
          {problems.slice(0, 8).map((problem, index) => (
            <div key={index}>{problem}</div>
          ))}
          {problems.length > 8 && <div>…共 {problems.length} 条</div>}
        </div>
      )}
    </div>
  );
}

/** 代理巡检：定时测活 + 死 IP 自动清理 + 服务商 API 自动提取新 IP（双写两侧） */
function PatrolCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['proxies', 'patrol'],
    queryFn: () => proxiesApi.patrol(),
    refetchInterval: (query) => (query.state.data?.running ? 5000 : 30000),
  });

  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState('60');
  const [removeDeadAfter, setRemoveDeadAfter] = useState('2');
  const [autoExtract, setAutoExtract] = useState(false);
  const [providerApiUrl, setProviderApiUrl] = useState('');
  const [minAlive, setMinAlive] = useState('3');
  const [protocolSub2api, setProtocolSub2api] = useState('socks5');
  const [protocolLocal, setProtocolLocal] = useState('socks5h');
  const [syncSub2api, setSyncSub2api] = useState(true);

  useEffect(() => {
    if (!data || loaded) return;
    setLoaded(true);
    setEnabled(Boolean(data.enabled));
    setIntervalSeconds(String(data.interval_seconds ?? 60));
    setRemoveDeadAfter(String(data.remove_dead_after ?? 2));
    setAutoExtract(Boolean(data.auto_extract));
    setProviderApiUrl(data.provider_api_url || '');
    setMinAlive(String(data.min_alive ?? 3));
    setProtocolSub2api(data.extract_protocol_sub2api || 'socks5');
    setProtocolLocal(data.extract_protocol_local || 'socks5h');
    setSyncSub2api(data.sync_sub2api !== false);
  }, [data, loaded]);

  const invalidatePatrol = () => {
    queryClient.invalidateQueries({ queryKey: ['proxies', 'patrol'] });
    queryClient.invalidateQueries({ queryKey: ['proxies'] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      proxiesApi.updatePatrol({
        enabled,
        interval_seconds: Number(intervalSeconds) || 60,
        remove_dead_after: Number(removeDeadAfter) || 0,
        auto_extract: autoExtract,
        provider_api_url: providerApiUrl,
        min_alive: Number(minAlive) || 1,
        extract_protocol_sub2api: protocolSub2api,
        extract_protocol_local: protocolLocal,
        sync_sub2api: syncSub2api,
      }),
    onSuccess: () => {
      toast.success('巡检设置已保存');
      invalidatePatrol();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const checkMutation = useMutation({
    mutationFn: () => proxiesApi.patrolCheck(),
    onSuccess: () => {
      toast.success('已开始一轮巡检，结果稍后刷新');
      invalidatePatrol();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const logs = data?.logs ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>代理巡检</CardTitle>
          {data?.enabled ? (
            <Badge variant="success">已启用</Badge>
          ) : (
            <Badge variant="muted">未启用</Badge>
          )}
          {data?.running && (
            <Badge variant="info">
              <Loader2 className="h-3 w-3 animate-spin" /> 巡检中
            </Badge>
          )}
          <Badge variant={data && data.alive_count > 0 ? 'success' : 'danger'}>可用 {data?.alive_count ?? 0}</Badge>
          {data?.next_check_at && !data.running && (
            <span className="text-xs text-muted-foreground">下轮 {formatRelativeTime(data.next_check_at)}</span>
          )}
          {data?.last_check_at && (
            <span className="text-xs text-muted-foreground">上轮 {formatDateTime(data.last_check_at)}</span>
          )}
        </div>
        <CardDescription>
          定时测活本机代理；连续失败的死 IP 自动清理；可用数低于阈值时经服务商 API 自动提取新 IP
          （本机与本机协议、sub2api 与 sub2api 协议双写），并把绑在死代理上的 sub2api 账号自动改绑后删除死代理
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={saveMutation.isPending} />
            启用自动巡检
          </label>
          <div className="space-y-1.5">
            <Label>巡检间隔（秒，最小 30）</Label>
            <Input
              value={intervalSeconds}
              onChange={(e) => setIntervalSeconds(e.target.value)}
              inputMode="numeric"
              className="h-8"
              disabled={saveMutation.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label>连续失败 N 轮自动清理（0=不清理）</Label>
            <Input
              value={removeDeadAfter}
              onChange={(e) => setRemoveDeadAfter(e.target.value)}
              inputMode="numeric"
              className="h-8"
              disabled={saveMutation.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label>最小可用代理数（低于即自动提取）</Label>
            <Input
              value={minAlive}
              onChange={(e) => setMinAlive(e.target.value)}
              inputMode="numeric"
              className="h-8"
              disabled={saveMutation.isPending || !autoExtract}
            />
          </div>
          <div className="space-y-1.5">
            <Label>提取后写入 sub2api 的协议</Label>
            <Select value={protocolSub2api} onValueChange={setProtocolSub2api} disabled={saveMutation.isPending}>
              <SelectTrigger aria-label="sub2api 协议" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PROXY_PROTOCOLS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>提取后写入本机列表的协议</Label>
            <Select value={protocolLocal} onValueChange={setProtocolLocal} disabled={saveMutation.isPending}>
              <SelectTrigger aria-label="本机协议" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PROXY_PROTOCOLS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Switch checked={autoExtract} onCheckedChange={setAutoExtract} disabled={saveMutation.isPending} />
          可用数低于阈值时经服务商 API 自动提取新 IP
        </label>
        {autoExtract && (
          <div className="space-y-1.5">
            <Label>服务商 API 提取链接</Label>
            <Input
              value={providerApiUrl}
              onChange={(e) => setProviderApiUrl(e.target.value)}
              placeholder="https://apisocks.1024proxy.com/api/getIpInfo?key=…&num=1&type=3&format=n"
              className="font-mono text-xs"
              disabled={saveMutation.isPending}
            />
            <p className="text-xs text-muted-foreground">
              粘贴服务商后台生成的完整链接（国家 / 端口 / 类型等参数原样保留），系统仅在提取时动态覆盖 num 数量参数；
              ips 白名单可不填 —— 服务商会自动把发起请求的本服务器出口 IP 加白
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={syncSub2api} onCheckedChange={setSyncSub2api} disabled={saveMutation.isPending} />
            死 IP 自动改绑 sub2api 账号并删除死代理
          </label>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => checkMutation.mutate()} disabled={checkMutation.isPending || data?.running}>
            {checkMutation.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            立即巡检
          </Button>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Save />}
            保存巡检设置
          </Button>
        </div>

        {data?.last_error && (
          <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            上轮出错：{data.last_error}
          </div>
        )}

        {logs.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">最近巡检记录</div>
            {logs.map((log) => (
              <PatrolLogRow key={log.id} log={log} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PatrolLogRow({ log }: { log: ProxyPatrolLog }) {
  const s = log.summary || {};
  const errors = [
    log.error,
    s.extract_error ? `提取失败：${s.extract_error}` : null,
    s.sub2api_error ? `sub2api 同步失败：${s.sub2api_error}` : null,
    s.sub2api?.rebound_error,
    ...(s.sub2api?.skipped ?? []).map((item) => `sub2api 死代理 #${item.id} ${item.name} 未删除：${item.reason}`),
  ].filter(Boolean) as string[];
  return (
    <details className="rounded-md border px-2.5 py-2 text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{formatDateTime(log.started_at)}</span>
        {log.status === 'done' && <Badge variant="success">完成</Badge>}
        {log.status === 'failed' && <Badge variant="danger">失败</Badge>}
        {log.status === 'skipped' && <Badge variant="muted">跳过</Badge>}
        {log.status === 'running' && <Badge variant="info">进行中</Badge>}
        {s.skipped === 'test_worker_busy' && <span className="text-muted-foreground">测活批次占用</span>}
        {s.tested !== undefined && <span>测 {s.tested}</span>}
        {s.alive !== undefined && <span className="text-primary">活 {s.alive}</span>}
        {s.dead !== undefined && s.dead > 0 && <span className="text-destructive">死 {s.dead}</span>}
        {s.cf_challenge !== undefined && s.cf_challenge > 0 && <span className="text-warning">CF {s.cf_challenge}</span>}
        {s.removed_local !== undefined && s.removed_local > 0 && <span>清理 {s.removed_local}</span>}
        {s.extracted !== undefined && s.extracted > 0 && <span>提取 {s.extracted}</span>}
        {s.imported_local !== undefined && s.imported_local > 0 && <span>导入 {s.imported_local}</span>}
        {s.sub2api && (s.sub2api.rebound_total > 0 || s.sub2api.created > 0 || s.sub2api.deleted > 0) && (
          <span className="text-muted-foreground">
            sub2api：建 {s.sub2api.created} · 改绑 {s.sub2api.rebound_total} · 删 {s.sub2api.deleted}
          </span>
        )}
      </summary>
      {errors.length > 0 && (
        <div className="mt-1.5 space-y-1 rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
          {errors.slice(0, 4).map((error, index) => (
            <div key={index}>{error}</div>
          ))}
          {errors.length > 4 && <div>…共 {errors.length} 条</div>}
        </div>
      )}
    </details>
  );
}
