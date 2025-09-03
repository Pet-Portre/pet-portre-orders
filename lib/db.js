// Cached Mongo client helper
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI");
const DB_NAME = process.env.MONGODB_DB || "pet-portre";

let client;
let clientPromise;

if (!global._mongo) global._mongo = {};
if (!global._mongo.clientPromise) {
  client = new MongoClient(uri, { maxPoolSize: 5 });
  global._mongo.clientPromise = client.connect();
}
clientPromise = global._mongo.clientPromise;

export async function getDb() {
  const c = await clientPromise;
  return c.db(DB_NAME);
}
