import type { OrderStatus } from '@/lib/types';

export interface SagaStep {
  label: string;
  /** Which service performs the step. */
  service: 'orders' | 'inventory' | 'notifications';
  state: 'done' | 'active' | 'todo' | 'failed';
}

/**
 * The order saga as the user sees it. The client only knows the order status,
 * which is enough to tell how far the choreography got:
 * orders (PENDING) → inventory reserves or rejects → orders confirms or rejects.
 */
export function sagaSteps(status: OrderStatus): SagaStep[] {
  const received: SagaStep = { label: 'Order received', service: 'orders', state: 'done' };
  switch (status) {
    case 'PENDING':
      return [
        received,
        { label: 'Reserving stock', service: 'inventory', state: 'active' },
        { label: 'Confirmed', service: 'orders', state: 'todo' },
      ];
    case 'CONFIRMED':
      return [
        received,
        { label: 'Stock reserved', service: 'inventory', state: 'done' },
        { label: 'Confirmed', service: 'orders', state: 'done' },
      ];
    case 'REJECTED':
      return [
        received,
        { label: 'Stock not available', service: 'inventory', state: 'failed' },
        { label: 'Rejected', service: 'orders', state: 'failed' },
      ];
    case 'CANCELLED':
      return [
        received,
        { label: 'Stock reserved', service: 'inventory', state: 'done' },
        { label: 'Cancelled, stock released', service: 'inventory', state: 'failed' },
      ];
  }
}

export const STATUS_TONE = {
  PENDING: 'warning',
  CONFIRMED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
} as const;
