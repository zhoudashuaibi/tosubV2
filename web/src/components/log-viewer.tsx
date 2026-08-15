import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Pause } from 'lucide-react';
import { jobsApi } from '@/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 任务日志增量查看器：2s 轮询、自动滚底、暂停滚动 */
export function LogViewer({ jobId }: { jobId: string }) {
  const [chunks, setChunks] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [eof, setEof] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['jobs', jobId, 'logs', offset],
    queryFn: () => jobsApi.logs(jobId, offset),
    refetchInterval: (query) => (query.state.data?.eof ? false : 2000),
    enabled: Boolean(jobId),
  });

  useEffect(() => {
    if (!data) return;
    if (data.chunk) setChunks((prev) => [...prev, data.chunk].slice(-500));
    setEof(data.eof);
    if (data.next_offset > offset) setOffset(data.next_offset);
  }, [data]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [chunks, autoScroll]);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <Button variant="outline" size="sm" onClick={() => setAutoScroll((v) => !v)}>
          {autoScroll ? <Pause className="h-3 w-3" /> : <ArrowDownToLine className="h-3 w-3" />}
          {autoScroll ? '暂停滚动' : '回到底部'}
        </Button>
      </div>
      <div ref={containerRef} className="max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-black/55 p-3 font-mono text-xs leading-relaxed text-zinc-200 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]">
        {chunks.length === 0 && <div className="text-zinc-500">暂无日志…</div>}
        {chunks.map((chunk, i) => (
          <pre key={i} className="whitespace-pre-wrap break-all">
            {chunk}
          </pre>
        ))}
        {!eof && <div className="text-zinc-500">▍</div>}
      </div>
    </div>
  );
}
