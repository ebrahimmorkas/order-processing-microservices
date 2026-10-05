import { useSyncExternalStore } from 'react';
import type { Product } from '@/lib/types';

/** sku → quantity */
export type Cart = Readonly<Record<string, number>>;

/** The orders service accepts at most this many units of one SKU per order. */
export const MAX_PER_ITEM = 20;

export function setQuantity(cart: Cart, sku: string, quantity: number): Cart {
  const next = { ...cart };
  const clamped = Math.min(MAX_PER_ITEM, Math.max(0, Math.floor(quantity)));
  if (clamped === 0) delete next[sku];
  else next[sku] = clamped;
  return next;
}

export const addOne = (cart: Cart, sku: string) => setQuantity(cart, sku, (cart[sku] ?? 0) + 1);

export const cartCount = (cart: Cart) => Object.values(cart).reduce((sum, q) => sum + q, 0);

export interface CartLine {
  product: Product;
  quantity: number;
  /** More units than the catalog currently shows in stock. */
  exceedsStock: boolean;
}

/** Joins the cart with the catalog; SKUs that no longer exist are dropped. */
export function cartLines(cart: Cart, products: Product[]): CartLine[] {
  return products
    .filter((p) => cart[p.sku])
    .map((product) => ({
      product,
      quantity: cart[product.sku]!,
      exceedsStock: cart[product.sku]! > product.stock,
    }));
}

export const cartTotal = (lines: CartLine[]) =>
  lines.reduce((sum, l) => sum + l.product.priceCents * l.quantity, 0);

export const toOrderItems = (cart: Cart) =>
  Object.entries(cart).map(([sku, quantity]) => ({ sku, quantity }));

// --- A tiny persistent store, so the cart survives reloads and is shared by all components. ---

const KEY = 'parcel.cart';
const listeners = new Set<() => void>();
let current: Cart = read();

function read(): Cart {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Cart;
  } catch {
    return {};
  }
}

export const cartStore = {
  get: () => current,
  update(fn: (cart: Cart) => Cart) {
    current = fn(current);
    localStorage.setItem(KEY, JSON.stringify(current));
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export const useCart = () => useSyncExternalStore(cartStore.subscribe, cartStore.get);
