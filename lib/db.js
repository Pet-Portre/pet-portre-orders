// lib/db.js
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'Pet-Portre-Orders';
if (!URI) throw new Error('Missing MONGODB_URI');

let clientPromise;

/** Get (and cache) a connected MongoClient across invocations */
async function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(URI, { maxPoolSize: 5 });
    clientPromise = client.connect();
  }
  return clientPromise;
}

/** Get a db handle */
async function getDb() {
  const client = await getClient();
  return client.db(DB_NAME);
}

/** Small helper: run an async fn with a db handle */
async function withDb(fn) {
  const db = await getDb();
  return fn(db);
}

module.exports = { getDb, withDb };
