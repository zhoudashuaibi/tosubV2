import { create } from 'zustand';

interface UiState {
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme:
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  sidebarCollapsed: false,
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      try {
        localStorage.setItem('tosub2-theme', next);
      } catch {}
      return { theme: next };
    }),
  setTheme: (theme) =>
    set(() => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      return { theme };
    }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
