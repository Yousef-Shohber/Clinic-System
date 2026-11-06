import { Job } from "bullmq";
import { createWorker } from "./queue.definitions";
import { Appointment } from "../models/appointment.model";
import { User } from "../models/user.model";
import { AppointmentStatus, NotificationType } from "../types/enums";
import { emailService } from "../services/email.service";
import { wsEmit } from "../services/websocket.service";
import { logger } from "../config/logger";

interface NotificationJobData {
  type: NotificationType;
  appointmentId: string;
  userId: string;
}

export function startNotificationWorker() {
  const worker = createWorker(
    "notifications",
    async (job: Job<NotificationJobData>) => {
      const { type, appointmentId, userId } = job.data;

      // Resolve email from userId
      const user = await User.findById(userId).select("email");
      if (!user) {
        logger.warn({ userId }, "User not found for notification");
        return;
      }

      // Get appointment with doctor info
      const appointment = await Appointment.findById(appointmentId).populate<{
        doctorId: { doctorName: string };
      }>("doctorId", "doctorName");

      if (!appointment) {
        logger.warn(
          { appointmentId },
          "Appointment not found for notification",
        );
        return;
      }

      // A reminder for an appointment that was cancelled/expired meanwhile
      // would be wrong and confusing
      if (
        type === NotificationType.APPOINTMENT_REMINDER &&
        appointment.status !== AppointmentStatus.CONFIRMED
      ) {
        logger.info(
          { appointmentId, status: appointment.status },
          "Reminder skipped: appointment no longer confirmed",
        );
        return;
      }

      const doctorName =
        (appointment.doctorId as unknown as { doctorName: string })
          .doctorName ?? "Doctor";
      const date = appointment.date.toISOString().split("T")[0]!;
      const { startTime } = appointment;

      switch (type) {
        case NotificationType.APPOINTMENT_CONFIRMED:
          await emailService.send(user.email, "appointment_confirmed", {
            doctorName,
            date,
            startTime,
          });
          break;

        case NotificationType.APPOINTMENT_CANCELLED:
          await emailService.send(user.email, "appointment_cancelled", {
            doctorName,
            date,
            startTime,
          });
          break;

        case NotificationType.APPOINTMENT_EXPIRED:
          await emailService.send(user.email, "appointment_expired", {
            doctorName,
            date,
            startTime,
          });
          break;

        case NotificationType.APPOINTMENT_COMPLETED:
          await emailService.send(user.email, "appointment_completed", {
            doctorName,
            date,
          });
          break;

        case NotificationType.APPOINTMENT_REMINDER:
          await emailService.send(user.email, "appointment_reminder", {
            doctorName,
            date,
            startTime,
          });
          wsEmit.appointmentReminder(userId, {
            appointmentId,
            date,
            startTime,
          });
          break;

        default:
          logger.warn({ type }, "Unknown notification type");
      }

      logger.info({ type, userId, appointmentId }, "Notification sent");
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Notification job failed");
  });

  logger.info("Notification worker started");
  return worker;
}
