import { describe, expect, it } from 'vitest';
import type { Product } from '@/lib/types';
import { sagaSteps } from '../orders/saga';
import {
  addOne,
  cartCount,
  cartLines,
  cartTotal,
  MAX_PER_ITEM,
  setQuantity,
  toOrderItems,
} from './cart';

const products: Product[] = [
  { sku: 'KB-01', name: 'Keyboard', priceCents: 8999, stock: 50 },
  { sku: 'LT-01', name: 'Lamp', priceCents: 4999, stock: 2 },
];

describe('cart', () => {
  it('adds, counts and removes items', () => {
    let cart = addOne(addOne(addOne({}, 'KB-01'), 'KB-01'), 'LT-01');
    expect(cart).toEqual({ 'KB-01': 2, 'LT-01': 1 });
    expect(cartCount(cart)).toBe(3);
    cart = setQuantity(cart, 'LT-01', 0);
    expect(cart).toEqual({ 'KB-01': 2 });
  });

  it('clamps quantities to the per-item limit', () => {
    expect(setQuantity({}, 'KB-01', 999)['KB-01']).toBe(MAX_PER_ITEM);
    expect(setQuantity({ 'KB-01': 1 }, 'KB-01', -5)).toEqual({});
  });

  it('prices lines, flags quantities above stock and drops unknown SKUs', () => {
    const lines = cartLines({ 'KB-01': 2, 'LT-01': 3, 'GONE-9': 1 }, products);
    expect(lines.map((l) => [l.product.sku, l.exceedsStock])).toEqual([
      ['KB-01', false],
      ['LT-01', true],
    ]);
    expect(cartTotal(lines)).toBe(2 * 8999 + 3 * 4999);
  });

  it('converts to the order payload', () => {
    expect(toOrderItems({ 'KB-01': 2 })).toEqual([{ sku: 'KB-01', quantity: 2 }]);
  });
});

describe('sagaSteps', () => {
  const labels = (status: Parameters<typeof sagaSteps>[0]) =>
    sagaSteps(status).map((s) => `${s.label}:${s.state}`);

  it('shows the reservation in progress while pending', () => {
    expect(labels('PENDING')).toEqual([
      'Order received:done',
      'Reserving stock:active',
      'Confirmed:todo',
    ]);
  });

  it('completes every step when confirmed', () => {
    expect(labels('CONFIRMED')).toEqual([
      'Order received:done',
      'Stock reserved:done',
      'Confirmed:done',
    ]);
  });

  it('ends in a failure step when inventory rejects the order', () => {
    expect(labels('REJECTED')).toEqual([
      'Order received:done',
      'Stock not available:failed',
      'Rejected:failed',
    ]);
  });

  it('adds the compensation step after a cancellation', () => {
    expect(labels('CANCELLED').at(-1)).toBe('Cancelled, stock released:failed');
  });
});
