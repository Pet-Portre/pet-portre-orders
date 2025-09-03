// lib/db.js
import { MongoClient } from "mongodb";

let _client;
let _conn;

export async function getDb() {
  if (!_conn) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("Missing MONGODB_URI");

    _client = new MongoClient(uri, {
      // keep defaults; Vercel functions are short-lived
    });
    _conn = _client.connect();
  }
  await _conn;
  const dbName = process.env.MONGODB_DB || "pet-portre"; // <- keep 'pet-portre'
  return _client.db(dbName);
}
