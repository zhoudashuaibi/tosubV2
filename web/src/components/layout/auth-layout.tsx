import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { MobileNavigation } from '@/components/layout/mobile-navigation';

export function AuthLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="app-shell flex min-h-dvh bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col lg:h-dvh">
        <Header title={title} />
        <main className="app-main flex-1 px-4 pb-24 pt-4 sm:px-6 sm:pb-8 lg:overflow-y-auto lg:px-8 lg:pt-5">{children}</main>
      </div>
      <MobileNavigation />
    </div>
  );
}
