import mongoose from "mongoose";
import { logger } from "../config/logger";

export async function migrateAppointmentIndexes(): Promise<void> {
  const col = mongoose.connection.collection("appointments");
  let indexes: Array<Record<string, unknown>>;
  try {
    indexes = (await col.indexes()) as Array<Record<string, unknown>>;
  } catch (err) {
    // Collection doesn't exist yet: nothing to migrate
    if ((err as { codeName?: string }).codeName === "NamespaceNotFound") return;
    throw err;
  }

  for (const idx of indexes) {
    const name = idx.name as string;
    const isLegacySlot =
      name === "doctorId_1_date_1_startTime_1" ||
      (idx.unique === true &&
        !idx.partialFilterExpression &&
        name !== "_id_" &&
        JSON.stringify(idx.key) ===
          JSON.stringify({ doctorId: 1, date: 1, startTime: 1 }));
    const isLegacyTtl =
      name === "expiresAt_1" && idx.expireAfterSeconds !== undefined;

    if (isLegacySlot || isLegacyTtl) {
      logger.warn({ index: name }, "Dropping legacy appointments index");
      await col.dropIndex(name);
    }
  }
}
