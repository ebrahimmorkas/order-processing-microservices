import { ArrowLeft, Check, ChevronRight, Loader2, X } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui/feedback';
import { useCancelOrder, useOrder, useOrders, useProducts } from '@/features/shop/api';
import { errorMessage } from '@/lib/api';
import { ago, formatDateTime, formatMoney, shortId } from '@/lib/format';
import type { Order, OrderStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { sagaSteps, STATUS_TONE } from './saga';

const label = (status: OrderStatus) => status.charAt(0) + status.slice(1).toLowerCase();
const units = (order: Order) => order.items.reduce((sum, i) => sum + i.quantity, 0);

export function OrdersPage() {
  const { data: orders, isPending, isError, error, refetch } = useOrders();
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Your orders</h1>
      {isPending ? (
        <Skeleton className="h-48" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Orders you place appear here with their status."
          action={
            <Link to="/" className={buttonVariants()}>
              Browse the catalog
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                to={`/orders/${order.id}`}
                className="flex items-center gap-4 p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Order #{shortId(order.id)}</p>
                  <p className="text-sm text-slate-500">
                    {units(order)} item{units(order) === 1 ? '' : 's'} · {ago(order.createdAt)}
                  </p>
                </div>
                {order.totalCents !== null && (
                  <span className="font-semibold tabular-nums">
                    {formatMoney(order.totalCents)}
                  </span>
                )}
                <Badge tone={STATUS_TONE[order.status]}>{label(order.status)}</Badge>
                <ChevronRight className="size-5 text-slate-400" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OrderPage() {
  const { id = '' } = useParams();
  const { data: order, isPending, isError, error, refetch } = useOrder(id);
  const products = useProducts().data ?? [];
  const cancel = useCancelOrder(id);

  if (isPending) return <Spinner />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  const name = (sku: string) => products.find((p) => p.sku === sku)?.name ?? sku;
  const cancellable = order.status === 'PENDING' || order.status === 'CONFIRMED';
  // Prices come from the inventory service once it has reserved the stock.
  const rows: { sku: string; quantity: number; priceCents: number | null }[] = order.lines.length
    ? order.lines.map((l) => ({ ...l, priceCents: l.unitPriceCents * l.quantity }))
    : order.items.map((i) => ({ ...i, priceCents: null }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/orders"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"
      >
        <ArrowLeft className="size-4" aria-hidden /> All orders
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Order #{shortId(order.id)}</h1>
          <p className="text-sm text-slate-500">Placed {formatDateTime(order.createdAt)}</p>
        </div>
        <Badge
          tone={STATUS_TONE[order.status]}
          className="px-3 py-1 text-sm"
          data-testid="order-status"
        >
          {label(order.status)}
        </Badge>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>What happened behind the scenes</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-4 sm:grid-cols-3" aria-live="polite">
            {sagaSteps(order.status).map((step) => (
              <li key={step.label} className="flex items-start gap-3">
                <span
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-full text-white',
                    step.state === 'done' && 'bg-emerald-500',
                    step.state === 'active' && 'bg-amber-500',
                    step.state === 'failed' && 'bg-red-500',
                    step.state === 'todo' && 'bg-slate-300 dark:bg-slate-700',
                  )}
                >
                  {step.state === 'done' && <Check className="size-4" aria-hidden />}
                  {step.state === 'active' && (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  )}
                  {step.state === 'failed' && <X className="size-4" aria-hidden />}
                </span>
                <div>
                  <p className="font-medium">{step.label}</p>
                  <p className="text-xs text-slate-500">{step.service} service</p>
                </div>
              </li>
            ))}
          </ol>
          {order.status === 'REJECTED' && order.rejectionReason && (
            <div className="mt-4">
              <Alert>{order.rejectionReason}</Alert>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <caption className="sr-only">Items in this order</caption>
            <thead className="text-left text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Product</th>
                <th className="pb-2 text-right font-medium">Qty</th>
                <th className="pb-2 text-right font-medium">Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sku} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-2">{name(row.sku)}</td>
                  <td className="py-2 text-right">{row.quantity}</td>
                  <td className="py-2 text-right tabular-nums">
                    {row.priceCents === null ? '—' : formatMoney(row.priceCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            {order.totalCents !== null && (
              <tfoot>
                <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                  <td className="pt-3" colSpan={2}>
                    Total
                  </td>
                  <td className="pt-3 text-right tabular-nums">{formatMoney(order.totalCents)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </CardContent>
      </Card>

      {cancellable && (
        <Button
          variant="ghost"
          className="text-red-600"
          loading={cancel.isPending}
          onClick={() =>
            cancel.mutate(undefined, {
              onSuccess: () => toast.success('Order cancelled. Stock was released.'),
              onError: (err) => toast.error(errorMessage(err)),
            })
          }
        >
          Cancel order
        </Button>
      )}
    </div>
  );
}
