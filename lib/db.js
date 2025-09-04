// lib/db.js
const { MongoClient } = require('mongodb');

let cached = global._pp_mongo || { client: null, db: null };

async function getDB() {
  if (cached.db) return cached.db;

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;

  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!dbName) throw new Error('MONGODB_DB is not set');

  if (!cached.client) {
    cached.client = new MongoClient(uri, { maxPoolSize: 5 });
    await cached.client.connect();
  }
  cached.db = cached.client.db(dbName);
  global._pp_mongo = cached;
  return cached.db;
}

module.exports = { getDB };
