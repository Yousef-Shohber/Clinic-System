import { Job } from "bullmq";
import { createWorker } from "./queue.definitions";
import { Appointment } from "../models/appointment.model";
import {
  AppointmentStatus,
  PaymentStatus,
  NotificationType,
} from "../types/enums";
import { cacheService } from "../services/cache.service";
import { wsEmit } from "../services/websocket.service";
import { getNotificationQueue } from "./queue.definitions";
import { logger } from "../config/logger";

interface ExpirationJobData {
  appointmentId?: string;
}

const SWEEP_EVERY_MS = 60_000;
const SWEEP_BATCH = 200;

async function afterExpired(appointmentId: string): Promise<void> {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) return;

  // Invalidate slots cache
  await cacheService.invalidateDoctorSlots(appointment.doctorId.toString());

  // WebSocket
  wsEmit.appointmentExpired(appointment.patientId.toString(), appointmentId);

  // Email notification (deterministic id: no duplicate on retry)
  await getNotificationQueue().add(
    NotificationType.APPOINTMENT_EXPIRED,
    {
      type: NotificationType.APPOINTMENT_EXPIRED,
      appointmentId,
      userId: appointment.patientId.toString(),
    },
    {
      jobId: `expired-${appointmentId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    },
  );

  logger.info({ appointmentId }, "Appointment expired");
}

/**
 * Atomic pending → expired. Compare-and-set on the status, so it can never
 * overwrite a payment that was confirmed (or a cancel) a moment earlier.
 * Returns true if THIS call performed the transition.
 */
async function expireIfPending(
  appointmentId: string,
  onlyIfOverdue: boolean,
): Promise<boolean> {
  const filter: Record<string, unknown> = {
    _id: appointmentId,
    status: AppointmentStatus.PENDING,
    paymentStatus: { $ne: PaymentStatus.PAID },
  };
  if (onlyIfOverdue) filter.expiresAt = { $lte: new Date() };

  const expired = await Appointment.findOneAndUpdate(filter, {
    status: AppointmentStatus.EXPIRED,
  });
  return expired !== null;
}

/**
 * Safety net for lost/failed delayed jobs (Redis flushed, crash between creating
 * the appointment and queueing its job, ...). Replaces the old TTL index, which
 * deleted documents instead of expiring them. Deliberately a plain in-process
 * timer rather than a BullMQ scheduler: it must keep working even if Redis lost
 * its state. Safe with several instances because expireIfPending is a CAS.
 */
async function sweepOverdue(): Promise<void> {
  const overdue = await Appointment.find({
    status: AppointmentStatus.PENDING,
    expiresAt: { $lte: new Date() },
  })
    .select("_id")
    .limit(SWEEP_BATCH)
    .lean();

  for (const { _id } of overdue) {
    const id = _id.toString();
    try {
      if (await expireIfPending(id, true)) await afterExpired(id);
    } catch (err) {
      logger.error({ err, appointmentId: id }, "Sweep: expire failed");
    }
  }
}

export function startExpirationWorker() {
  const worker = createWorker(
    "appointment-expiration",
    async (job: Job<ExpirationJobData>) => {
      const { appointmentId } = job.data;
      if (!appointmentId) return;

      const transitioned = await expireIfPending(appointmentId, false);
      if (transitioned) {
        await afterExpired(appointmentId);
        return;
      }

      // A previous attempt of this very job may have flipped the status and then
      // failed on a side effect; finish those on retry.
      if (job.attemptsMade > 0) {
        const current =
          await Appointment.findById(appointmentId).select("status");
        if (current?.status === AppointmentStatus.EXPIRED) {
          await afterExpired(appointmentId);
        }
      }
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Expiration job failed");
  });

  const sweepTimer = setInterval(() => {
    sweepOverdue().catch((err) => logger.error({ err }, "Expiry sweep failed"));
  }, SWEEP_EVERY_MS);
  sweepTimer.unref();
  worker.on("closing", () => clearInterval(sweepTimer));
  // also catch up right after a restart
  sweepOverdue().catch((err) => logger.error({ err }, "Expiry sweep failed"));

  logger.info("Expiration worker started");
  return worker;
}
