import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, ListChecks, Loader2, Send, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { jobsApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import { PROMPT_LABELS, STAGE_LABELS, isBannedJobError } from '@/api/types';
import type { Job } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { LogViewer } from '@/components/log-viewer';
import { FilterSelect } from '@/components/filter-select';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';

const PAGE_SIZE = 100;

const TYPE_LABELS: Record<string, string> = {
  login: '登录',
  refresh: '刷新',
  balance: '余额',
  totp_setup: '2FA',
};

export function JobsPage() {
  const queryClient = useQueryClient();
  const [statusTab, setStatusTab] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState('30');

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', { statusTab, typeFilter, q, page }],
    queryFn: () =>
      jobsApi.list({
        status: statusTab || undefined,
        type: typeFilter || undefined,
        q: q || undefined,
        page,
        page_size: PAGE_SIZE,
      }),
    refetchInterval: 2000,
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 筛选/清理导致总页数缩小时，把当前页拉回范围内
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const cleanupMutation = useMutation({
    mutationFn: (days: number) => jobsApi.cleanup(days),
    onSuccess: (result) => {
      toast.success(result.deleted > 0 ? `已清理 ${result.deleted} 条任务` : '没有符合条件的任务');
      setCleanupOpen(false);
      setExpanded(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => jobsApi.cancel(id),
    onSuccess: () => {
      toast.success('任务已取消');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => jobsApi.retry(id),
    onSuccess: () => {
      toast.success('重试任务已创建');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const cancelAllMutation = useMutation({
    mutationFn: () => jobsApi.cancelAll(),
    onSuccess: (result) => {
      toast.success(`已取消 ${result.canceled} 个任务`);
      setCancelAllOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = data?.items ?? [];
  const stats = data?.stats ?? { queued: 0, running: 0, awaiting_input: 0 };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="muted">排队 {stats.queued}</Badge>
        <Badge variant="info">进行中 {stats.running}</Badge>
        <Badge variant="warning">待输入 {stats.awaiting_input}</Badge>
        <div className="flex-1" />
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="搜索邮箱…"
          className="h-6 w-48"
        />
        <FilterSelect
          value={typeFilter}
          onValueChange={(value) => {
            setTypeFilter(value);
            setPage(1);
          }}
          label="全部类型"
          className="w-[124px]"
          options={[
            { value: 'login', label: '登录' },
            { value: 'refresh', label: '刷新' },
            { value: 'balance', label: '余额' },
            { value: 'totp_setup', label: '2FA' },
          ]}
        />
        <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>
          <Trash2 />
          清理
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setCancelAllOpen(true)}>
          <XCircle />
          取消全部
        </Button>
      </div>

      <div className="flex gap-1 border-b">
        {[
          ['', '全部'],
          ['active', '进行中'],
          ['awaiting_input', '待输入'],
          ['completed', '已完成'],
          ['failed', '失败'],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => {
              setStatusTab(value);
              setPage(1);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              statusTab === value
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-card">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={ListChecks} title="暂无任务" description="从号池发起加入/授权/余额查询后，任务会出现在这里" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>邮箱</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>尝试</TableHead>
                <TableHead>代理</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  expanded={expanded === job.id}
                  onToggle={() => setExpanded((prev) => (prev === job.id ? null : job.id))}
                  onCancel={() => cancelMutation.mutate(job.id)}
                  onRetry={() => retryMutation.mutate(job.id)}
                  busy={cancelMutation.isPending || retryMutation.isPending}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>共 {total} 条任务</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            下一页
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={cancelAllOpen}
        onOpenChange={setCancelAllOpen}
        title="取消全部活跃任务？"
        description="排队、进行中、等待输入的任务都会被取消。"
        confirmText="全部取消"
        busy={cancelAllMutation.isPending}
        onConfirm={() => cancelAllMutation.mutate()}
      />

      <Dialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>清理历史任务</DialogTitle>
            <DialogDescription>
              任务默认全部保留。输入天数，早于该天数结束的任务（含日志与产物文件）将被删除，进行中的任务不受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 px-1">
            <span className="text-sm">清理</span>
            <Input
              type="number"
              min={0}
              value={cleanupDays}
              onChange={(e) => setCleanupDays(e.target.value)}
              className="w-24"
            />
            <span className="text-sm">天前结束的任务</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupOpen(false)} disabled={cleanupMutation.isPending}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={cleanupMutation.isPending || cleanupDays.trim() === '' || Number(cleanupDays) < 0 || !Number.isInteger(Number(cleanupDays))}
              onClick={() => cleanupMutation.mutate(Number(cleanupDays))}
            >
              {cleanupMutation.isPending ? '清理中…' : '清理'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function JobRow({
  job,
  expanded,
  onToggle,
  onCancel,
  onRetry,
  busy,
}: {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const queryClient = useQueryClient();
  const [inputValue, setInputValue] = useState('');

  const inputMutation = useMutation({
    mutationFn: ({ action, value }: { action: string; value?: string }) => jobsApi.input(job.id, action, value),
    onSuccess: (_, variables) => {
      toast.success(variables.action === 'input' ? '输入已提交' : '指令已发送');
      setInputValue('');
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <TableRow className={job.status === 'awaiting_input' ? 'bg-[var(--warning)]/5' : undefined}>
        <TableCell>
          <button onClick={onToggle} className="rounded p-1 hover:bg-muted">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell className="max-w-[200px] truncate font-mono text-xs">{job.email ?? '—'}</TableCell>
        <TableCell>{TYPE_LABELS[job.type] ?? job.type}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <StatusBadge domain="job" value={job.status} />
            {job.status === 'failed' && isBannedJobError(job.error) ? (
              <Badge variant="danger">账号封禁/停用</Badge>
            ) : (
              job.stage && <span className="text-xs text-muted-foreground">{STAGE_LABELS[job.stage] ?? job.stage}</span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-xs">{job.attempt}</TableCell>
        <TableCell className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">
          {job.proxy_display ?? '本机直连'}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground" title={formatDateTime(job.started_at)}>
          {formatRelativeTime(job.started_at ?? job.created_at)}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            {job.can_cancel && (
              <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
                取消
              </Button>
            )}
            {job.can_retry && job.status !== 'completed' && (
              <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
                <RotateCcw className="h-3.5 w-3.5" />
                重试
              </Button>
            )}
            {job.status === 'completed' && job.has_result && (
              <Button size="sm" variant="outline" onClick={() => download(`/jobs/${job.id}/result`, `${job.id}.json`)}>
                <Download className="h-3.5 w-3.5" />
                产物
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/30 p-4">
            <div className="space-y-3">
              {job.error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  错误：{job.error}
                </div>
              )}
              {job.status === 'awaiting_input' && job.prompt_kind && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3">
                  <span className="text-sm font-medium">
                    {PROMPT_LABELS[job.prompt_kind] ?? job.prompt_kind}：
                  </span>
                  <Input
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder={
                      job.prompt_kind?.includes('otp')
                        ? '6 位验证码'
                        : job.prompt_kind === 'phone'
                          ? '+8613800000000'
                          : '输入内容'
                    }
                    className="w-56 font-mono"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && inputValue.trim()) {
                        inputMutation.mutate({ action: 'input', value: inputValue.trim() });
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => inputValue.trim() && inputMutation.mutate({ action: 'input', value: inputValue.trim() })}
                    disabled={inputMutation.isPending || !inputValue.trim()}
                  >
                    {inputMutation.isPending ? <Loader2 className="animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    提交
                  </Button>
                  {(job.prompt_kind === 'email_otp' || job.prompt_kind === 'phone_otp') && (
                    <Button size="sm" variant="outline" onClick={() => inputMutation.mutate({ action: 'resend' })}>
                      重发验证码
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => inputMutation.mutate({ action: 'quit' })}>
                    放弃
                  </Button>
                </div>
              )}
              <LogViewer jobId={job.id} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
