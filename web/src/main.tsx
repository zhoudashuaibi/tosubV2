import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { router } from './router';
import './styles.css';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('App crashed:', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#dc2626', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
          <h2>应用渲染出错</h2>
          <div>{String(this.state.error?.message)}</div>
          <pre style={{ fontSize: 12 }}>{String(this.state.error?.stack)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 2_000,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof TypeError || /failed to fetch/i.test(String(error.message))) {
        toast.error('网络异常，请检查服务是否可达');
      }
    },
  }),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
    <Toaster richColors position="top-center" />
  </QueryClientProvider>,
);
