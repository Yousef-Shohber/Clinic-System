import { Queue, Worker, WorkerOptions, Processor } from "bullmq";
import getRedis from "../config/redis";
import { logger } from "../config/logger";

function getBullMQConnection() {
  return getRedis().duplicate();
}

let _expirationQueue: Queue | null = null;
let _notificationQueue: Queue | null = null;

export function getExpirationQueue(): Queue {
  if (!_expirationQueue) {
    _expirationQueue = new Queue("appointment-expiration", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });
    // An unhandled 'error' event on a BullMQ object would crash the process
    _expirationQueue.on("error", (err) =>
      logger.error({ err }, "Expiration queue error"),
    );
  }
  return _expirationQueue;
}

export function getNotificationQueue(): Queue {
  if (!_notificationQueue) {
    _notificationQueue = new Queue("notifications", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });
    _notificationQueue.on("error", (err) =>
      logger.error({ err }, "Notification queue error"),
    );
  }
  return _notificationQueue;
}

export function createWorker(
  queueName: string,
  processor: Processor,
  options?: Partial<WorkerOptions>,
): Worker {
  const worker = new Worker(queueName, processor, {
    connection: getBullMQConnection(),
    ...options,
  });
  worker.on("error", (err) => logger.error({ err, queueName }, "Worker error"));
  return worker;
}
