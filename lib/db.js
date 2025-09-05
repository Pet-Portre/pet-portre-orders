// lib/db.js
const { MongoClient } = require('mongodb');

let clientPromise;

function getClient() {
  if (!clientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('Missing MONGODB_URI');
    clientPromise = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 15000,
    }).connect();
  }
  return clientPromise;
}

async function getDb() {
  const name = process.env.MONGODB_DB || 'Pet-Portre-Orders';
  const client = await getClient();
  return client.db(name);
}

async function withDb(task) {
  const db = await getDb();
  return task(db);
}

module.exports = { withDb, getDb };
