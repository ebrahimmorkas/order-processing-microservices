process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-that-is-definitely-long-enough';
process.env.EVENT_BUS ??= 'mongo';
// Every test file gets its own databases under this prefix.
process.env.TEST_MONGO_URL ??= 'mongodb://localhost:27017';
