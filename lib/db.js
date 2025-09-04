// Reusable MongoDB connection for Vercel (Node 18, CJS)
const { MongoClient } = require('mongodb');

let cached = global._mongoCached;
if (!cached) cached = global._mongoCached = { client: null, promise: null };

async function getDb() {
  if (cached.client) return cached.client.db(process.env.MONGODB_DB || 'pet-portre');

  if (!cached.promise) {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
    cached.promise = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 })
      .connect()
      .then(client => {
        cached.client = client;
        return client;
      });
  }
  const client = await cached.promise;
  return client.db(process.env.MONGODB_DB || 'pet-portre');
}

module.exports = { getDb };
