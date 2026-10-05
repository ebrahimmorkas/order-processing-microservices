import { Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, ErrorState, Skeleton } from '@/components/ui/feedback';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { Product } from '@/lib/types';
import { usePlaceOrder, useProducts } from './api';
import {
  addOne,
  cartLines,
  cartStore,
  cartTotal,
  MAX_PER_ITEM,
  setQuantity,
  toOrderItems,
  useCart,
} from './cart';

export function ShopPage() {
  const products = useProducts();
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <section aria-labelledby="catalog-heading">
        <h1 id="catalog-heading" className="text-3xl font-bold tracking-tight">
          Catalog
        </h1>
        <p className="mt-1 text-slate-500">
          Stock is reserved by the inventory service after you order. Try ordering more than is in
          stock to see the saga reject it.
        </p>
        {products.isPending ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : products.isError ? (
          <div className="mt-6">
            <ErrorState error={products.error} onRetry={() => products.refetch()} />
          </div>
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {products.data.map((product) => (
              <li key={product.sku}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <CartPanel products={products.data ?? []} />
    </div>
  );
}

function ProductCard({ product }: { product: Product }) {
  const inCart = useCart()[product.sku] ?? 0;
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-mono text-xs text-slate-500">{product.sku}</p>
            <h2 className="font-semibold">{product.name}</h2>
          </div>
          {product.stock === 0 ? (
            <Badge tone="danger">Out of stock</Badge>
          ) : product.stock <= 5 ? (
            <Badge tone="warning">Only {product.stock} left</Badge>
          ) : (
            <Badge tone="success">{product.stock} in stock</Badge>
          )}
        </div>
        <div className="mt-auto flex items-center justify-between">
          <span className="text-xl font-bold">{formatMoney(product.priceCents)}</span>
          <Button
            size="sm"
            disabled={inCart >= MAX_PER_ITEM}
            onClick={() => cartStore.update((c) => addOne(c, product.sku))}
          >
            <Plus aria-hidden /> Add{inCart > 0 && ` (${inCart})`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CartPanel({ products }: { products: Product[] }) {
  const cart = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const placeOrder = usePlaceOrder();
  // One key per checkout attempt; it changes only after the order is accepted.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const lines = cartLines(cart, products);
  const risky = lines.some((l) => l.exceedsStock);

  const checkout = () => {
    if (!user) return navigate('/login', { state: { from: location.pathname } });
    placeOrder.mutate(
      { items: toOrderItems(cart), idempotencyKey },
      {
        onSuccess: (order) => {
          cartStore.update(() => ({}));
          setIdempotencyKey(crypto.randomUUID());
          toast.success('Order placed. Reserving stock…');
          navigate(`/orders/${order.id}`);
        },
      },
    );
  };

  return (
    <aside aria-labelledby="cart-heading">
      <Card className="lg:sticky lg:top-24">
        <CardHeader>
          <CardTitle id="cart-heading" className="flex items-center gap-2">
            <ShoppingCart className="size-4" aria-hidden /> Your cart
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {lines.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">Your cart is empty.</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {lines.map(({ product, quantity, exceedsStock }) => (
                  <li key={product.sku} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{product.name}</span>
                      <span className="text-sm tabular-nums">
                        {formatMoney(product.priceCents * quantity)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="icon"
                        className="size-7"
                        aria-label={`Remove one ${product.name}`}
                        onClick={() =>
                          cartStore.update((c) => setQuantity(c, product.sku, quantity - 1))
                        }
                      >
                        <Minus />
                      </Button>
                      <output className="w-6 text-center text-sm font-semibold tabular-nums">
                        {quantity}
                      </output>
                      <Button
                        variant="secondary"
                        size="icon"
                        className="size-7"
                        aria-label={`Add one ${product.name}`}
                        disabled={quantity >= MAX_PER_ITEM}
                        onClick={() =>
                          cartStore.update((c) => setQuantity(c, product.sku, quantity + 1))
                        }
                      >
                        <Plus />
                      </Button>
                      {exceedsStock && <Badge tone="warning">More than in stock</Badge>}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto size-7 text-slate-400"
                        aria-label={`Remove ${product.name} from cart`}
                        onClick={() => cartStore.update((c) => setQuantity(c, product.sku, 0))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
                <span className="text-slate-500">Estimated total</span>
                <span className="text-xl font-bold">{formatMoney(cartTotal(lines))}</span>
              </div>
              {risky && (
                <Alert tone="info">
                  Some quantities exceed the stock shown. You can still order; the inventory service
                  will decide and the order may be rejected.
                </Alert>
              )}
              {placeOrder.isError && <Alert>{errorMessage(placeOrder.error)}</Alert>}
              <Button
                size="lg"
                className="w-full"
                loading={placeOrder.isPending}
                onClick={checkout}
              >
                {user ? 'Place order' : 'Log in to order'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}
