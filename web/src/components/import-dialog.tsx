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
  twofaPlaceholder,
  passwordsPlaceholder,
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
  /** 传入即渲染第二个「2FA 取件码」输入框 */
  twofaPlaceholder?: string;
  /** 传入即渲染第三个「ChatGPT 密码文件」输入框 */
  passwordsPlaceholder?: string;
  submitLabel?: string;
  onSubmit: (text: string, twofaText: string, passwordsText: string) => void;
  result: ImportResult | ProxyImportResult | null;
  onClosed?: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState('');
  const [twofaText, setTwofaText] = useState('');
  const [passwordsText, setPasswordsText] = useState('');

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setText('');
      setTwofaText('');
      setPasswordsText('');
      onClosed?.();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {twofaPlaceholder ? '每行一条，支持以 # 开头的注释行；2FA 取件码与密码按邮箱自动关联' : '每行一条，支持以 # 开头的注释行'}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          className="min-h-[130px] font-mono text-xs"
          spellCheck={false}
        />
        {twofaPlaceholder && (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">2FA 取件码（可选，仅需要两步验证的账号）</div>
            <Textarea
              value={twofaText}
              onChange={(e) => setTwofaText(e.target.value)}
              placeholder={twofaPlaceholder}
              className="min-h-[60px] font-mono text-xs"
              spellCheck={false}
            />
          </div>
        )}
        {passwordsPlaceholder && (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">ChatGPT 密码文件（可选，ChatGPT 会话导出 JSON）</div>
            <Textarea
              value={passwordsText}
              onChange={(e) => setPasswordsText(e.target.value)}
              placeholder={passwordsPlaceholder}
              className="min-h-[60px] font-mono text-xs"
              spellCheck={false}
            />
          </div>
        )}
        {result && <ImportResultView result={result} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            关闭
          </Button>
          <Button
            onClick={() => onSubmit(text, twofaText, passwordsText)}
            disabled={busy || (!text.trim() && !twofaText.trim() && !passwordsText.trim())}
          >
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
      {isAccountResult(result) && result.twofa_bound ? (
        <div className="flex items-start gap-2 text-[var(--info)]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>已绑定 2FA 取件码 {result.twofa_bound} 条</span>
        </div>
      ) : null}
      {isAccountResult(result) && (result.twofa_unmatched?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>2FA 取件码未匹配到账号：{joinEmails(result.twofa_unmatched ?? [])}</span>
        </div>
      )}
      {isAccountResult(result) && (result.twofa_invalid_lines?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {(result.twofa_invalid_lines ?? []).slice(0, 8).map((line) => (
              <div key={line.line}>
                2FA 第 {line.line} 行：{line.reason}
              </div>
            ))}
            {(result.twofa_invalid_lines?.length ?? 0) > 8 && <div>…共 {result.twofa_invalid_lines?.length} 行非法</div>}
          </div>
        </div>
      )}
      {isAccountResult(result) && result.passwords_error && (
        <div className="flex items-start gap-2 text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>密码文件解析失败：{result.passwords_error}</span>
        </div>
      )}
      {isAccountResult(result) && result.passwords_bound ? (
        <div className="flex items-start gap-2 text-[var(--info)]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>已绑定 ChatGPT 密码 {result.passwords_bound} 条</span>
        </div>
      ) : null}
      {isAccountResult(result) && (result.passwords_unmatched?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>ChatGPT 密码未匹配到账号：{joinEmails(result.passwords_unmatched ?? [])}</span>
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
