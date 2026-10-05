import { Bell, LogOut, Moon, Package, ShoppingCart, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Button, buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { useHealth, useMarkRead, useNotifications } from '@/features/shop/api';
import { cartCount, useCart } from '@/features/shop/cart';
import { ago } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-lg px-3 py-2 text-sm font-medium',
    isActive
      ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-100'
      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
  );

export function AppLayout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const count = cartCount(useCart());
  const health = useHealth();

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4">
          <Link to="/" className="mr-2 flex items-center gap-2 font-bold">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
              <Package className="size-4" aria-hidden />
            </span>
            Parcel
          </Link>
          <nav aria-label="Main" className="flex flex-1 items-center gap-1">
            <NavLink to="/" end className={linkClass}>
              Shop
            </NavLink>
            {user && (
              <NavLink to="/orders" className={linkClass}>
                Orders
              </NavLink>
            )}
            <NavLink to="/status" className={linkClass}>
              <span className="flex items-center gap-1.5">
                System
                <span
                  className={cn(
                    'size-2 rounded-full',
                    !health.data
                      ? 'bg-slate-300'
                      : health.data.status === 'ok'
                        ? 'bg-emerald-500'
                        : 'bg-red-500',
                  )}
                  aria-label={
                    health.data?.status === 'ok' ? 'All services up' : 'Some services down'
                  }
                />
              </span>
            </NavLink>
          </nav>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          <Link
            to="/"
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative')}
            aria-label={`Cart, ${count} items`}
          >
            <ShoppingCart />
            {count > 0 && <Dot>{count}</Dot>}
          </Link>
          {user ? (
            <>
              <NotificationBell />
              <span className="hidden text-sm font-medium sm:block">{user.name}</span>
              <Button variant="ghost" size="icon" aria-label="Log out" onClick={logout}>
                <LogOut />
              </Button>
            </>
          ) : (
            <Link to="/login" className={buttonVariants({ size: 'sm' })}>
              Log in
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

function Dot({ children }: { children: number }) {
  return (
    <span className="absolute -top-0.5 -right-0.5 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-brand-600 px-1 text-[0.625rem] font-bold text-white">
      {children > 99 ? '99+' : children}
    </span>
  );
}

/** Notifications are written by a separate service as the saga progresses. */
function NotificationBell() {
  const { data } = useNotifications();
  const markRead = useMarkRead();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell />
        {unread > 0 && <Dot>{unread}</Dot>}
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <p className="border-b border-slate-200 px-4 py-2 text-sm font-semibold dark:border-slate-700">
            Notifications
          </p>
          <ul className="max-h-96 overflow-y-auto">
            {data?.data.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-slate-500">
                Nothing yet. Place an order!
              </li>
            )}
            {data?.data.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  disabled={n.read}
                  onClick={() => markRead.mutate(n.id)}
                  className={cn(
                    'block w-full px-4 py-3 text-left text-sm hover:bg-slate-50 disabled:cursor-default dark:hover:bg-slate-800',
                    !n.read && 'bg-brand-50/60 dark:bg-brand-900/20',
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {!n.read && (
                      <span className="size-2 rounded-full bg-brand-600" aria-label="Unread" />
                    )}
                    {n.title}
                  </span>
                  <span className="block text-slate-600 dark:text-slate-400">{n.message}</span>
                  <span className="text-xs text-slate-400">{ago(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
