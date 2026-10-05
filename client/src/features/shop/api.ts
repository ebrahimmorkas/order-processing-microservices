import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_URL } from '@/lib/api';
import type { Health, Notification, Order, Product } from '@/lib/types';

export const keys = {
  products: ['products'] as const,
  orders: ['orders'] as const,
  order: (id: string) => ['orders', id] as const,
  notifications: ['notifications'] as const,
  health: ['health'] as const,
};

export function useProducts() {
  return useQuery({
    queryKey: keys.products,
    queryFn: async ({ signal }) => (await api<{ data: Product[] }>('/products', { signal })).data,
    // Stock changes as orders are reserved; keep the catalog reasonably fresh.
    refetchInterval: 10_000,
  });
}

export function useOrders() {
  return useQuery({
    queryKey: keys.orders,
    queryFn: async ({ signal }) => (await api<{ data: Order[] }>('/orders', { signal })).data,
    // Orders are confirmed asynchronously by the saga, so poll while any is pending.
    refetchInterval: (query) =>
      query.state.data?.some((o) => o.status === 'PENDING') ? 1000 : false,
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: keys.order(id),
    queryFn: async ({ signal }) => (await api<{ order: Order }>(`/orders/${id}`, { signal })).order,
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' ? 700 : false),
  });
}

export function usePlaceOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      items,
      idempotencyKey,
    }: {
      items: { sku: string; quantity: number }[];
      idempotencyKey: string;
    }) =>
      api<{ order: Order }>('/orders', {
        method: 'POST',
        body: { items },
        // A retried or double-clicked checkout returns the same order instead of a second one.
        headers: { 'Idempotency-Key': idempotencyKey },
      }).then((r) => r.order),
    onSuccess: (order) => {
      queryClient.setQueryData(keys.order(order.id), order);
      void queryClient.invalidateQueries({ queryKey: keys.orders });
    },
  });
}

export function useCancelOrder(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ order: Order }>(`/orders/${id}/cancel`, { method: 'POST' }).then((r) => r.order),
    onSuccess: (order) => {
      queryClient.setQueryData(keys.order(id), order);
      void queryClient.invalidateQueries({ queryKey: keys.orders });
      void queryClient.invalidateQueries({ queryKey: keys.products });
      void queryClient.invalidateQueries({ queryKey: keys.notifications });
    },
  });
}

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: keys.notifications,
    enabled,
    queryFn: ({ signal }) =>
      api<{ data: Notification[]; unreadCount: number }>('/notifications', { signal }),
    refetchInterval: 4000,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/** The gateway aggregates the health of every downstream service. */
export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: async ({ signal }) => {
      // 503 still carries the per-service breakdown, so read the body either way.
      const res = await fetch(`${API_URL}/health`, { signal });
      return (await res.json()) as Health;
    },
    refetchInterval: 5000,
  });
}
