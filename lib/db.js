// lib/db.js  (CommonJS)
const { MongoClient } = require('mongodb');

let cached = global._mongoClient;
if (!cached) cached = (global._mongoClient = { conn: null, promise: null });

async function getClient() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI missing');
    const client = new MongoClient(uri, { maxPoolSize: 5 });
    cached.promise = client.connect().then(c => c);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

module.exports = { getClient };
