import mongoose from "mongoose";
import { logger } from "./logger";
import getEnv from "./env";

export async function connectDatabase(): Promise<void> {
  const env = getEnv();
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 5000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      logger.info({ attempt }, "Connecting to MongoDB...");
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: RETRY_DELAY_MS,
      });
      logger.info("MongoDB connected");
      return;
    } catch (err) {
      logger.error(
        { attempt, err },
        `MongoDB connection attempt ${attempt} failed`,
      );
      if (attempt < MAX_ATTEMPTS) {
        logger.info(
          { delay: RETRY_DELAY_MS },
          `Retrying in ${RETRY_DELAY_MS}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        logger.error("All MongoDB connection attempts failed");
        throw err;
      }
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info("MongoDB disconnected");
}

export function getDatabaseStatus(): string {
  const states: Record<number, string> = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  return states[mongoose.connection.readyState] ?? "unknown";
}
