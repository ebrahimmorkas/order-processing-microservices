import { ArrowRight, Bell, Boxes, KeyRound, Network, ShoppingBag } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useHealth } from '@/features/shop/api';
import type { ServiceName } from '@/lib/types';
import { cn } from '@/lib/utils';

const SERVICES: { name: ServiceName; title: string; icon: typeof Boxes; role: string }[] = [
  { name: 'auth', title: 'Auth', icon: KeyRound, role: 'Accounts and JWTs' },
  {
    name: 'orders',
    title: 'Orders',
    icon: ShoppingBag,
    role: 'Order state and transactional outbox',
  },
  { name: 'inventory', title: 'Inventory', icon: Boxes, role: 'Catalog and stock reservations' },
  { name: 'notifications', title: 'Notifications', icon: Bell, role: 'Messages for order events' },
];

const FLOW = ['order.created', 'inventory.reserved / rejected', 'order.confirmed / rejected'];

/** Live view of the system: the gateway reports the health of every service behind it. */
export function StatusPage() {
  const { data, isPending, isError } = useHealth();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">System status</h1>
        <p className="mt-1 text-slate-500">
          This app talks only to the API gateway. Behind it, four services cooperate through events.
          This page refreshes every five seconds.
        </p>
      </header>

      {isError && <Alert>The API gateway cannot be reached.</Alert>}

      <Card>
        <CardContent className="flex items-center gap-3">
          <Network className="size-8 text-brand-600" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">API gateway</p>
            <p className="text-sm text-slate-500">
              Authenticates requests and routes them to services
            </p>
          </div>
          <StatusPill up={!isError && !!data} loading={isPending} />
        </CardContent>
      </Card>

      <ul className="grid gap-4 sm:grid-cols-2">
        {SERVICES.map(({ name, title, icon: Icon, role }) => (
          <li key={name}>
            <Card className="h-full">
              <CardContent className="flex items-center gap-3">
                <Icon className="size-7 text-slate-500" aria-hidden />
                <div className="flex-1">
                  <p className="font-semibold">{title} service</p>
                  <p className="text-sm text-slate-500">{role}</p>
                </div>
                {isPending ? (
                  <Skeleton className="h-6 w-14" />
                ) : (
                  <StatusPill up={data?.services[name] === 'up'} />
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <section aria-labelledby="flow-heading">
        <h2 id="flow-heading" className="text-lg font-semibold">
          How an order flows
        </h2>
        <ol className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {FLOW.map((event, i) => (
            <li key={event} className="flex items-center gap-2">
              <code className="rounded-lg bg-slate-200 px-2.5 py-1 dark:bg-slate-800">{event}</code>
              {i < FLOW.length - 1 && <ArrowRight className="size-4 text-slate-400" aria-hidden />}
            </li>
          ))}
        </ol>
        <p className="mt-3 max-w-2xl text-sm text-slate-500">
          Placing an order returns immediately with status <em>Pending</em>. The inventory service
          then reserves stock (or rejects the order), the orders service confirms it, and the
          notifications service tells you. Cancelling an order releases the stock again.
        </p>
      </section>
    </div>
  );
}

function StatusPill({ up, loading }: { up: boolean; loading?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        loading
          ? 'bg-slate-100 text-slate-500 dark:bg-slate-800'
          : up
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
      )}
    >
      <span
        className={cn(
          'size-2 rounded-full',
          loading ? 'bg-slate-400' : up ? 'bg-emerald-500' : 'bg-red-500',
        )}
      />
      {loading ? 'Checking' : up ? 'Up' : 'Down'}
    </span>
  );
}
