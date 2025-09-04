// lib/db.js
const { MongoClient } = require('mongodb');

let _client;
let _db;

async function getClient() {
  if (_client) return _client;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Missing MONGODB_URI env var');
  _client = new MongoClient(uri, { maxPoolSize: 2 });
  await _client.connect();
  return _client;
}

async function getDb() {
  if (_db) return _db;
  const client = await getClient();
  const name = process.env.MONGODB_DB || 'Pet-Portre-Orders';
  _db = client.db(name);
  return _db;
}

module.exports = { getDb, getClient };
