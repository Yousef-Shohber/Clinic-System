import {
  Appointment,
  IAppointment,
  ACTIVE_SLOT_STATUSES,
} from "../../models/appointment.model";
import { Doctor } from "../../models/doctor.model";
import { Schedule } from "../../models/schedule.model";
import { AppError } from "../../types/errors";
import {
  AppointmentStatus,
  PaymentStatus,
  NotificationType,
  Role,
} from "../../types/enums";
import { cacheService, REDIS_KEYS } from "../../services/cache.service";
import { lockService } from "../../services/lock.service";
import { wsEmit } from "../../services/websocket.service";
import { generateSlots, getDayName } from "../../utils/schedule-generator";
import {
  getExpirationQueue,
  getNotificationQueue,
} from "../../workers/queue.definitions";
import { refundPaidAppointment } from "../payment/payment.service";
import { clinicDateTimeToUtc, toDateString } from "../../utils/clinic-time";
import { logger } from "../../config/logger";
import getEnv from "../../config/env";
import {
  CreateAppointmentDtoType,
  ListMyAppointmentsDtoType,
  ListAllAppointmentsDtoType,
  CompleteAppointmentDtoType,
} from "./appointment.schema";

// ===== Book Appointment =====

export async function createAppointment(
  patientId: string,
  input: CreateAppointmentDtoType,
) {
  const { doctorId, date, startTime, patientNotes } = input;

  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw new AppError("NOT_FOUND", 404, "Doctor not found");
  if (!doctor.isVerified || !doctor.isActive) {
    throw new AppError("DOCTOR_UNAVAILABLE", 400, "Doctor is not available");
  }

  const dateObj = new Date(date + "T00:00:00Z");
  const duplicate = await Appointment.findOne({
    patientId,
    doctorId,
    date: dateObj,
    startTime,
    status: { $in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
  });
  if (duplicate) {
    throw new AppError(
      "DUPLICATE_APPOINTMENT",
      409,
      "You already have this appointment",
    );
  }

  const dayName = getDayName(date);
  const schedule = await Schedule.findOne({
    doctorId,
    day: dayName,
    isActive: true,
  });
  if (!schedule) {
    throw new AppError(
      "NO_SCHEDULE",
      400,
      "Doctor has no schedule for this day",
    );
  }

  const allSlots = generateSlots(
    schedule.startTime,
    schedule.endTime,
    schedule.slotDuration,
  );
  const slot = allSlots.find((s) => s.startTime === startTime);
  if (!slot) {
    throw new AppError("INVALID_SLOT", 400, "Invalid time slot");
  }

  // slot times are clinic wall-clock times: a slot that already started can't be booked
  if (clinicDateTimeToUtc(date, startTime).getTime() <= Date.now()) {
    throw new AppError(
      "SLOT_IN_PAST",
      400,
      "This time slot has already passed",
    );
  }

  const lockKey = REDIS_KEYS.slotLock(doctorId, date, startTime);
  const env = getEnv();
  const slotFilter = {
    doctorId,
    date: dateObj,
    startTime,
    status: { $in: ACTIVE_SLOT_STATUSES },
  };

  let appointment: IAppointment;
  try {
    appointment = await lockService.withLock(
      lockKey,
      env.LOCK_TTL_MS,
      async () => {
        const taken = await Appointment.exists(slotFilter);
        if (taken) {
          throw new AppError("SLOT_TAKEN", 409, "This slot is already booked");
        }

        try {
          return await Appointment.create({
            doctorId,
            patientId,
            scheduleId: schedule._id,
            date: dateObj,
            startTime,
            endTime: slot.endTime,
            patientNotes,
            status: AppointmentStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
          });
        } catch (err) {
          // The partial unique index is the real guarantee; the lock is only
          // an optimisation in front of it
          if ((err as { code?: number }).code === 11000) {
            throw new AppError(
              "SLOT_TAKEN",
              409,
              "This slot is already booked",
            );
          }
          throw err;
        }
      },
    );
  } catch (err) {
    // Under heavy contention the lock may not be obtained in time. If the slot
    // has been taken in the meantime, say so (409) instead of "try again" (503).
    if (err instanceof AppError && err.code === "LOCK_UNAVAILABLE") {
      if (await Appointment.exists(slotFilter)) {
        throw new AppError("SLOT_TAKEN", 409, "This slot is already booked");
      }
    }
    throw err;
  }

  // BullMQ delayed job — fires at expiresAt to expire if not paid
  try {
    await getExpirationQueue().add(
      "expire-appointment",
      { appointmentId: appointment._id.toString() },
      {
        jobId: appointment._id.toString(), // unique jobId عشان نقدر نشيله لو اتدفع
        delay: Math.max(0, appointment.expiresAt.getTime() - Date.now()),
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    );
  } catch (err) {
    // Partial failure: without its expiry job the hold could never be released.
    // Roll the booking back so the slot isn't blocked.
    await Appointment.deleteOne({ _id: appointment._id });
    throw err;
  }

  await cacheService.invalidateDoctorSlots(doctorId);

  wsEmit.appointmentCreated(patientId, {
    appointmentId: appointment._id.toString(),
    doctorId,
    date,
    startTime,
  });

  return appointment;
}

// ===== Get My Appointments =====

export async function getMyAppointments(
  userId: string,
  role: Role,
  query: ListMyAppointmentsDtoType,
) {
  const { status, page, limit } = query;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};

  if (role === Role.PATIENT) filter.patientId = userId;
  else if (role === Role.DOCTOR) {
    const doctor = await Doctor.findOne({ userId });
    if (!doctor)
      throw new AppError("NOT_FOUND", 404, "Doctor profile not found");
    filter.doctorId = doctor._id;
  }

  if (status) filter.status = status;

  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1, _id: -1 })
      .populate("doctorId", "doctorName specialization fees")
      .populate("patientId", "name email profilePhoto"),
    Appointment.countDocuments(filter),
  ]);

  return {
    appointments,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ===== Get All Appointments (Admin) =====

export async function getAllAppointments(query: ListAllAppointmentsDtoType) {
  const { status, doctorId, date, page, limit } = query;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (doctorId) filter.doctorId = doctorId;
  if (date) filter.date = new Date(date + "T00:00:00Z");

  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1, _id: -1 })
      .populate("doctorId", "doctorName specialization")
      .populate("patientId", "name email"),
    Appointment.countDocuments(filter),
  ]);

  return {
    appointments,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ===== Get Single Appointment =====

export async function getAppointmentById(
  appointmentId: string,
  userId: string,
  role: Role,
) {
  // doctor و admin يشوفوا الـ doctorNotes
  const query = Appointment.findById(appointmentId)
    .populate("doctorId", "doctorName specialization fees")
    .populate("patientId", "name email profilePhoto");

  if (role === Role.DOCTOR || role === Role.ADMIN) {
    query.select("+doctorNotes");
  }

  const appointment = await query;
  if (!appointment)
    throw new AppError("NOT_FOUND", 404, "Appointment not found");

  // patient يشوف appointment بتاعته بس
  if (
    role === Role.PATIENT &&
    appointment.patientId._id.toString() !== userId
  ) {
    throw new AppError("FORBIDDEN", 403, "Not your appointment");
  }

  // doctor يشوف appointments بتاعته بس
  if (role === Role.DOCTOR) {
    const doctor = await Doctor.findOne({ userId });
    if (
      !doctor ||
      appointment.doctorId._id.toString() !== doctor._id.toString()
    ) {
      throw new AppError("FORBIDDEN", 403, "Not your appointment");
    }
  }

  return appointment;
}

// ===== Cancel Appointment =====

export async function cancelAppointment(
  appointmentId: string,
  userId: string,
  role: Role,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment)
    throw new AppError("NOT_FOUND", 404, "Appointment not found");

  // Cancellation rules بالـ role
  if (role === Role.PATIENT) {
    if (appointment.patientId.toString() !== userId) {
      throw new AppError("FORBIDDEN", 403, "Not your appointment");
    }
    if (
      ![AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED].includes(
        appointment.status,
      )
    ) {
      throw new AppError(
        "INVALID_STATUS",
        400,
        "Cannot cancel this appointment",
      );
    }
  } else if (role === Role.DOCTOR) {
    const doctor = await Doctor.findOne({ userId });
    if (!doctor || appointment.doctorId.toString() !== doctor._id.toString()) {
      throw new AppError("FORBIDDEN", 403, "Not your appointment");
    }
    if (
      ![AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED].includes(
        appointment.status,
      )
    ) {
      throw new AppError(
        "INVALID_STATUS",
        400,
        "Cannot cancel this appointment",
      );
    }
  }
  // admin → can cancel any live appointment (a cancelled/expired one has nothing left to cancel)
  const cancellable: AppointmentStatus[] = [
    AppointmentStatus.PENDING,
    AppointmentStatus.CONFIRMED,
  ];
  if (role === Role.ADMIN) cancellable.push(AppointmentStatus.COMPLETED);

  // Atomic claim of the cancellation: two concurrent cancels (or a cancel racing
  // a payment/expiry) cannot both succeed, so refunds and emails happen once.
  const claimed = await Appointment.findOneAndUpdate(
    { _id: appointment._id, status: { $in: cancellable } },
    { status: AppointmentStatus.CANCELLED, cancelledAt: new Date() },
    { new: true },
  );
  if (!claimed) {
    throw new AppError("INVALID_STATUS", 400, "Cannot cancel this appointment");
  }

  // Remove expiry / reminder jobs (best effort — both workers re-check status)
  try {
    const job = await getExpirationQueue().getJob(appointmentId);
    if (job) await job.remove();
    const reminder = await getNotificationQueue().getJob(
      `reminder-${appointmentId}`,
    );
    if (reminder) await reminder.remove();
  } catch (err) {
    logger.warn({ err, appointmentId }, "Could not remove queued jobs");
  }

  // Refund if it was paid. Runs under a per-appointment lock inside
  // refundPaidAppointment. If Paymob refuses, the appointment stays PAID (not
  // falsely REFUNDED) so an admin can retry via POST /payments/refund/:id.
  if (claimed.paymentStatus === PaymentStatus.PAID) {
    try {
      await refundPaidAppointment(appointmentId);
    } catch (err) {
      logger.error(
        { err, appointmentId },
        "Refund failed while cancelling; appointment left PAID for retry",
      );
    }
  }

  // Invalidate slots cache
  await cacheService.invalidateDoctorSlots(claimed.doctorId.toString());

  // WebSocket + notification
  wsEmit.appointmentCancelled(claimed.patientId.toString(), appointmentId);

  await getNotificationQueue().add(
    NotificationType.APPOINTMENT_CANCELLED,
    {
      type: NotificationType.APPOINTMENT_CANCELLED,
      appointmentId,
      userId: claimed.patientId.toString(),
    },
    {
      jobId: `cancelled-${appointmentId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    },
  );

  // Re-read so the response reflects the refund outcome
  return (await Appointment.findById(appointmentId)) ?? claimed;
}

// ===== Complete Appointment =====

export async function completeAppointment(
  appointmentId: string,
  userId: string,
  input: CompleteAppointmentDtoType,
) {
  const doctor = await Doctor.findOne({ userId });
  if (!doctor) throw new AppError("NOT_FOUND", 404, "Doctor profile not found");

  const appointment = await Appointment.findById(appointmentId);
  if (!appointment)
    throw new AppError("NOT_FOUND", 404, "Appointment not found");

  if (appointment.doctorId.toString() !== doctor._id.toString()) {
    throw new AppError("FORBIDDEN", 403, "Not your appointment");
  }

  if (appointment.status !== AppointmentStatus.CONFIRMED) {
    throw new AppError(
      "INVALID_STATUS",
      400,
      "Only confirmed appointments can be completed",
    );
  }

  // Compare-and-set so a concurrent cancel can't be overwritten by "completed"
  const update: Record<string, unknown> = {
    status: AppointmentStatus.COMPLETED,
  };
  if (input.doctorNotes) update.doctorNotes = input.doctorNotes;
  const completed = await Appointment.findOneAndUpdate(
    { _id: appointment._id, status: AppointmentStatus.CONFIRMED },
    update,
    { new: true },
  ).select("+doctorNotes");
  if (!completed) {
    throw new AppError(
      "INVALID_STATUS",
      400,
      "Only confirmed appointments can be completed",
    );
  }

  wsEmit.appointmentCompleted(appointment.patientId.toString(), appointmentId);

  await getNotificationQueue().add(
    NotificationType.APPOINTMENT_COMPLETED,
    {
      type: NotificationType.APPOINTMENT_COMPLETED,
      appointmentId,
      userId: appointment.patientId.toString(),
    },
    {
      jobId: `completed-${appointmentId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    },
  );

  return completed;
}
