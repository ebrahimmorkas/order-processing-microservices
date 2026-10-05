// Shapes returned through the API gateway.

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
}

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';

export interface Order {
  id: string;
  status: OrderStatus;
  items: { sku: string; quantity: number }[];
  /** Priced lines; filled in by the inventory service when it reserves stock. */
  lines: { sku: string; quantity: number; unitPriceCents: number }[];
  totalCents: number | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export type ServiceName = 'auth' | 'orders' | 'inventory' | 'notifications';

export interface Health {
  status: 'ok' | 'degraded';
  services: Record<ServiceName, 'up' | 'down'>;
}
