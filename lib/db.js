// lib/db.js (CommonJS)
const { MongoClient } = require('mongodb');

let clientPromise;

if (!global._mongoClientPromise) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var missing');
  const client = new MongoClient(uri, { maxPoolSize: 10 });
  global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

module.exports = async function getDb() {
  const conn = await clientPromise;
  return conn.db(process.env.MONGODB_DB || 'pet-portre'); // <— DB name
};
