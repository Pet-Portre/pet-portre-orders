// lib/db.js
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set");

const DB_NAME = process.env.MONGODB_DB || "Pet-Portre-Orders";

let client, clientPromise, cachedDb;
if (!global._petPortreMongo) {
  client = new MongoClient(uri, { maxPoolSize: 5 });
  clientPromise = client.connect().then(() => client);
  global._petPortreMongo = { clientPromise };
} else {
  clientPromise = global._petPortreMongo.clientPromise;
}

export async function getDb() {
  if (cachedDb) return cachedDb;
  const c = await clientPromise;
  cachedDb = c.db(DB_NAME);
  return cachedDb;
}
