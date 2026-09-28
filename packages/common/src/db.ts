import mongoose, { type Connection } from 'mongoose';

mongoose.set('strictQuery', true);

/**
 * Database-per-service: each service opens its own connection (and database)
 * instead of sharing the global mongoose connection. This also lets several
 * services run in one process during end-to-end tests.
 */
export async function connectMongo(url: string): Promise<Connection> {
  const connection = mongoose.createConnection(url, { serverSelectionTimeoutMS: 5000 });
  await connection.asPromise();
  return connection;
}
