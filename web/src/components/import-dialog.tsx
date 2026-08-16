import { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { joinEmails } from '@/lib/utils';
import type { ImportResult, ProxyImportResult } from '@/api/types';

function isAccountResult(result: ImportResult | ProxyImportResult): result is ImportResult {
  return 'duplicates_in_main' in result;
}

export function ImportDialog({
  open,
  onOpenChange,
  title,
  placeholder,
  submitLabel = '导入',
  onSubmit,
  result,
  onClosed,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  placeholder: string;
  submitLabel?: string;
  onSubmit: (text: string) => void;
  result: ImportResult | ProxyImportResult | null;
  onClosed?: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState('');

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setText('');
      onClosed?.();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>每行一条，支持以 # 开头的注释行</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          className="min-h-[180px] font-mono text-xs"
          spellCheck={false}
        />
        {result && <ImportResultView result={result} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            关闭
          </Button>
          <Button onClick={() => onSubmit(text)} disabled={busy || !text.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportResultView({ result }: { result: ImportResult | ProxyImportResult }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex items-center gap-2 text-[var(--success)]">
        <CheckCircle2 className="h-4 w-4" />
        成功导入 {result.created} 条
      </div>
      {isAccountResult(result) && result.duplicates_in_main.length > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{joinEmails(result.duplicates_in_main)} 已在主号池中</span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_in_reserve.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{joinEmails(result.duplicates_in_reserve)} 已在备用号池（凭据已更新）</span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_in_batch.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>批内重复已跳过：{joinEmails(result.duplicates_in_batch)}</span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_in_discard.length > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {result.duplicates_in_discard.map((d) => `${d.email}（${d.reason}）`).join('、')} 曾在废弃号池，重新导入需勾选「仍然导入」
          </span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_remote.length > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{joinEmails(result.duplicates_remote)} 已在远端 sub2api，可勾选强制导入</span>
        </div>
      )}
      {!isAccountResult(result) && result.duplicates.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>重复已跳过：{result.duplicates.length} 条</span>
        </div>
      )}
      {result.invalid_lines.length > 0 && (
        <div className="flex items-start gap-2 text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {result.invalid_lines.slice(0, 8).map((line) => (
              <div key={line.line}>
                第 {line.line} 行：{line.reason}
              </div>
            ))}
            {result.invalid_lines.length > 8 && <div>…共 {result.invalid_lines.length} 行非法</div>}
          </div>
        </div>
      )}
    </div>
  );
}
