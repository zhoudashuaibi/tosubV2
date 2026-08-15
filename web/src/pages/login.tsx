import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { authApi } from '@/api';
import { errorMessage } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginPage() {
  const navigate = useNavigate();
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => authApi.session(),
    retry: false,
  });
  const isSetup = session ? !session.password_initialized : false;

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (session?.authenticated) navigate({ to: '/' });
  }, [session, navigate]);

  const login = useMutation({
    mutationFn: () =>
      isSetup
        ? authApi.login({ new_password: password })
        : authApi.login({ password }),
    onSuccess: () => {
      toast.success(isSetup ? '密码已设置' : '登录成功');
      navigate({ to: '/' });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = () => {
    setError('');
    if (isSetup) {
      if (password.length < 8) return setError('密码至少 8 位');
      if (password !== confirm) return setError('两次输入的密码不一致');
    }
    if (!password) return setError('请输入密码');
    login.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6">
      <Card className="w-full max-w-[calc(100vw-2rem)] sm:max-w-[400px] overflow-hidden">
        <CardHeader className="border-b bg-muted/35 px-6 py-7 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-primary/30 bg-primary text-sm font-bold text-primary-foreground shadow-[0_0_24px_color-mix(in_srgb,var(--primary)_28%,transparent)]">
            S2
          </div>
          <div className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground">TO SUB 2 / ACCESS</div>
          <CardTitle className="mt-2 text-xl font-medium">toSub2 控制台</CardTitle>
          <CardDescription className="mt-1.5">
            {isSetup ? '首次访问，请设置访问密码' : '请输入访问密码'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 p-6 pt-6">
          {isSetup && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--warning)]/20 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              系统部署在公网，请设置强密码（至少 8 位）。密码用于保护账号凭据与令牌。
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="password">{isSetup ? '设置访问密码' : '访问密码'}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="••••••••"
              autoFocus
            />
          </div>
          {isSetup && (
            <div className="space-y-2">
              <Label htmlFor="confirm">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="再次输入密码"
              />
            </div>
          )}
          {error && <div className="text-sm text-destructive">{error}</div>}
          <Button className="w-full" onClick={submit} disabled={login.isPending}>
            <Lock className="h-4 w-4" />
            {isSetup ? '设置并登录' : '登录'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
