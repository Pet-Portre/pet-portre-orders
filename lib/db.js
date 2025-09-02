// Simple MongoDB helper with connection caching

const { MongoClient } = require('mongodb');

let cached = global.__PETPORTRE_DB__;
if (!cached) {
  cached = global.__PETPORTRE_DB__ = { client: null, db: null, uri: null, dbName: null };
}

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'Pet-Portre-Orders';

  if (!uri) throw new Error('MONGODB_URI is not set');
  if (cached.client && cached.db && cached.uri === uri && cached.dbName === dbName) {
    return { client: cached.client, db: cached.db };
  }
  const client = new MongoClient(uri, { maxPoolSize: 5 });
  await client.connect();
  const db = client.db(dbName);

  cached.client = client;
  cached.db = db;
  cached.uri = uri;
  cached.dbName = dbName;

  return { client, db };
}

module.exports = { connectToDatabase };
