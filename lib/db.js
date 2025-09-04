// lib/db.js
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'Pet-Portre-Orders';

if (!uri) throw new Error('MONGODB_URI missing');

let client;
let clientPromise;

if (!global._pp_db) {
  client = new MongoClient(uri, { maxPoolSize: 10 });
  clientPromise = client.connect();
  global._pp_db = clientPromise.then(c => c.db(dbName));
}

async function withDb(fn) {
  const db = await global._pp_db;
  return fn(db);
}

module.exports = { withDb };
