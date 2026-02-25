import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongoServer: MongoMemoryServer | null = null;

type MongooseConnectOptions = NonNullable<
  Parameters<typeof mongoose.connect>[1]
>;

export async function connectTestDb() {
  mongoServer = await MongoMemoryServer.create({
    instance: {
      storageEngine: "wiredTiger",
    },
  });

  const uri = mongoServer.getUri();

  const opts: MongooseConnectOptions = {
    serverSelectionTimeoutMS: 60_000,
  } as any;

  await mongoose.connect(uri, opts);
}

export async function clearTestDb() {
  const { connection } = mongoose;
  if (!connection?.db) return;

  const collections = await connection.db.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}

export async function disconnectTestDb() {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    } else {
      // not connected; nothing to drop
      await mongoose.disconnect().catch(() => {});
    }
  } finally {
    if (mongoServer) await mongoServer.stop();
    mongoServer = null;
  }
}
