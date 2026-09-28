import { Schema, type Connection, type InferSchemaType } from 'mongoose';

export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const itemSchema = new Schema(
  { sku: { type: String, required: true }, quantity: { type: Number, required: true } },
  { _id: false },
);

const lineSchema = new Schema(
  {
    sku: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceCents: { type: Number, required: true },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    userId: { type: String, required: true },
    items: { type: [itemSchema], required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'PENDING' },
    /** Priced lines, filled in once inventory confirms the reservation. */
    lines: { type: [lineSchema], default: [] },
    totalCents: { type: Number, default: null },
    rejectionReason: { type: String, default: null },
    idempotencyKey: { type: String, default: undefined },
    /** Every event of this order shares the id of the request that created it. */
    correlationId: { type: String, required: true },
    /**
     * Transactional outbox. Events are appended in the same single-document
     * (atomic) write as the state change and removed once published, so a state
     * change can never be persisted without its event, or vice versa.
     */
    outbox: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
// Lets the outbox relay find unpublished events without a collection scan.
orderSchema.index({ 'outbox.0': 1 }, { sparse: true });

export type Order = InferSchemaType<typeof orderSchema>;

export const createOrderModel = (connection: Connection) => connection.model('Order', orderSchema);

export type OrderModel = ReturnType<typeof createOrderModel>;
