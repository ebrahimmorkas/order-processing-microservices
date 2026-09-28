import { Schema, type Connection } from 'mongoose';

const holdSchema = new Schema(
  { orderId: { type: String, required: true }, quantity: { type: Number, required: true } },
  { _id: false },
);

const productSchema = new Schema(
  {
    sku: { type: String, required: true, unique: true, uppercase: true },
    name: { type: String, required: true },
    priceCents: { type: Number, required: true, min: 0 },
    /** Units available to sell. */
    stock: { type: Number, required: true, min: 0 },
    /**
     * Units held for orders. Kept on the product so that "decrement stock" and
     * "record which order holds it" are one atomic single-document update:
     * reserving/releasing is idempotent per order and can't leak stock.
     */
    holds: { type: [holdSchema], default: [] },
  },
  { timestamps: true },
);
productSchema.index({ 'holds.orderId': 1 });

export const RESERVATION_STATUSES = ['PENDING', 'RESERVED', 'REJECTED', 'CANCELLED'] as const;

/** One decision record per order (unique), used to make the saga idempotent. */
const reservationSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true },
    status: { type: String, enum: RESERVATION_STATUSES, required: true },
    lines: {
      type: [new Schema({ sku: String, quantity: Number, unitPriceCents: Number }, { _id: false })],
      default: [],
    },
    totalCents: { type: Number, default: null },
    reason: { type: String, default: null },
  },
  { timestamps: true },
);

export function createModels(connection: Connection) {
  return {
    Product: connection.model('Product', productSchema),
    Reservation: connection.model('Reservation', reservationSchema),
  };
}

export type InventoryModels = ReturnType<typeof createModels>;

export const DEMO_CATALOG = [
  { sku: 'KB-01', name: 'Mechanical Keyboard', priceCents: 8999, stock: 50 },
  { sku: 'MS-02', name: 'Wireless Mouse', priceCents: 2999, stock: 100 },
  { sku: 'MN-27', name: '27" 4K Monitor', priceCents: 32999, stock: 10 },
  { sku: 'HD-03', name: 'Noise-cancelling Headphones', priceCents: 19999, stock: 25 },
  { sku: 'LT-01', name: 'Limited Edition Desk Lamp', priceCents: 4999, stock: 2 },
];
