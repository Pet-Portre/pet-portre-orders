// lib/db.js (CommonJS, Node 18+)
const { MongoClient, ServerApiVersion } = require('mongodb');

const URI = process.env.MONGODB_URI;
if (!URI) throw new Error('MONGODB_URI is not set');

const DB_NAME = process.env.MONGODB_DB || 'pet-portre';

let _clientPromise;

/** Get a connected MongoClient (re-used across invocations) */
function getClient() {
  if (_clientPromise) return _clientPromise;
  const client = new MongoClient(URI, {
    // small pool — serverless friendly
    maxPoolSize: 5,
    serverApi: ServerApiVersion.v1,
  });
  _clientPromise = client.connect();
  return _clientPromise;
}

/** Get a DB handle for the configured database */
async function getDb() {
  const client = await getClient();
  return client.db(DB_NAME);
}

module.exports = { getClient, getDb };
