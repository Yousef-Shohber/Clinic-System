import dotenv from "dotenv";
dotenv.config();

import http from "http";
import { createApp } from "./app";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { connectRedis, disconnectRedis } from "./config/redis";
import { getEnv } from "./config/env";
import { logger } from "./config/logger";
import { initWebSocket, closeWebSocket } from "./services/websocket.service";
import { migrateAppointmentIndexes } from "./utils/migrations";
import { Appointment } from "./models/appointment.model";
import { startExpirationWorker } from "./workers/expiration.worker";
import { startNotificationWorker } from "./workers/notification.worker";

async function bootstrap() {
  const env = getEnv();
  const PORT = env.PORT;

  // Connect to databases
  await connectDatabase();
  await connectRedis();

  // Drop legacy appointment indexes (non-partial unique slot index, TTL index)
  // and make sure the new ones exist. Idempotent.
  await migrateAppointmentIndexes();
  await Appointment.createIndexes();

  // Create Express app
  const app = createApp();
  const httpServer = http.createServer(app);

  // Init WebSocket
  initWebSocket(httpServer);

  // Start BullMQ workers
  const expirationWorker = startExpirationWorker();
  const notificationWorker = startNotificationWorker();

  httpServer.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Environment: ${env.NODE_ENV}`);
  });

  // ===== Graceful Shutdown =====
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);

    const forced = setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    forced.unref();

    try {
      const cutoff = setTimeout(() => httpServer.closeAllConnections(), 3_000);
      cutoff.unref();
      setImmediate(() => httpServer.closeIdleConnections());
      await closeWebSocket();
      clearTimeout(cutoff);
      logger.info("HTTP + WebSocket server closed");

      // Close workers
      await expirationWorker.close();
      await notificationWorker.close();
      logger.info("Workers closed");

      // Disconnect databases
      await disconnectDatabase();
      await disconnectRedis();
      logger.info("Databases disconnected");

      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Handle unhandled rejections
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
    void shutdown("unhandledRejection");
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
