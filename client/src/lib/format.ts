import { format, formatDistanceToNowStrict } from 'date-fns';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const formatMoney = (cents: number) => currency.format(cents / 100);
export const formatDateTime = (iso: string) => format(new Date(iso), 'd MMM yyyy, h:mm a');
export const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
/** Orders are shown by the last 6 characters of their id, like the notifications do. */
export const shortId = (id: string) => id.slice(-6).toUpperCase();
