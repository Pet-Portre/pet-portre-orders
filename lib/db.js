// MongoDB connection helper (Node 18, CommonJS)
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'Pet-Portre-Orders';

if (!uri) {
  console.error('❌ MONGODB_URI is not set');
}

let cached = global._petPortreMongo;
if (!cached) {
  cached = global._petPortreMongo = { client: null, db: null };
}

async function getDB() {
  if (cached.db) return cached.db;

  const client = new MongoClient(uri, { maxPoolSize: 5 });
  await client.connect();

  const db = client.db(dbName);
  cached.client = client;
  cached.db = db;

  // lightweight index (you can extend later)
  await db.collection('orders').createIndex({ orderNumber: 1 }, { unique: true });
  await db.collection('orders').createIndex({ 'delivery.referenceId': 1 });

  return db;
}

module.exports = { getDB };
