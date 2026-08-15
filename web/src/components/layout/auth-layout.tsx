import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';

export function AuthLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="app-shell flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header title={title} />
        <main className="app-main flex-1 overflow-y-auto px-4 pb-6 pt-3 sm:px-6 sm:pb-8 sm:pt-4 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
