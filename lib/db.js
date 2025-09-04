// lib/db.js
'use strict';
const { MongoClient } = require('mongodb');

let clientPromise;

module.exports = async function getDb() {
  if (!clientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is missing');
    const client = new MongoClient(uri, { maxPoolSize: 5 });
    clientPromise = client.connect();
  }
  const conn = await clientPromise;
  const dbName = process.env.MONGODB_DB || 'pet-portre';
  return conn.db(dbName);
};
