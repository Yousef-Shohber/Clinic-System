import { Schedule, ISchedule } from "../../models/schedule.model";
import { Doctor } from "../../models/doctor.model";
import { AppError } from "../../types/errors";
import { cacheService, REDIS_KEYS } from "../../services/cache.service";
import {
  CreateScheduleDtoType,
  UpdateScheduleDtoType,
} from "./schedule.schema";

async function getDoctorIdByUserId(userId: string): Promise<string> {
  const doctor = await Doctor.findOne({ userId });
  if (!doctor) {
    throw new AppError("DOCTOR_NOT_FOUND", 404, "Doctor profile not found");
  }
  return doctor._id.toString();
}

async function invalidateDoctorSlotsCache(doctorId: string): Promise<void> {
  await cacheService.invalidateDoctorSlots(doctorId);
}

// ===== Create =====

export async function createSchedule(
  userId: string,
  input: CreateScheduleDtoType,
): Promise<ISchedule> {
  const doctorId = await getDoctorIdByUserId(userId);

  const existing = await Schedule.findOne({ doctorId, day: input.day });
  if (existing) {
    throw new AppError(
      "SCHEDULE_EXISTS",
      409,
      `Schedule for ${input.day} already exists`,
    );
  }

  const schedule = await Schedule.create({ doctorId, ...input });
  await invalidateDoctorSlotsCache(doctorId);
  return schedule;
}

// ===== Get My Schedules =====

export async function getMySchedules(userId: string): Promise<ISchedule[]> {
  const doctorId = await getDoctorIdByUserId(userId);
  return Schedule.find({ doctorId }).sort({ day: 1 });
}

// ===== Update =====

export async function updateSchedule(
  scheduleId: string,
  userId: string,
  input: UpdateScheduleDtoType,
): Promise<ISchedule> {
  const doctorId = await getDoctorIdByUserId(userId);

  const schedule = await Schedule.findById(scheduleId);
  if (!schedule) throw new AppError("NOT_FOUND", 404, "Schedule not found");

  if (schedule.doctorId.toString() !== doctorId) {
    throw new AppError("FORBIDDEN", 403, "Not your schedule");
  }

  // A partial update is only validated field-by-field by the DTO, so check the
  // merged result (e.g. moving only startTime past the stored endTime)
  const startTime = input.startTime ?? schedule.startTime;
  const endTime = input.endTime ?? schedule.endTime;
  const slotDuration = input.slotDuration ?? schedule.slotDuration;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const windowMinutes = eh * 60 + em - (sh * 60 + sm);
  if (windowMinutes <= 0 || windowMinutes < slotDuration) {
    throw new AppError(
      "VALIDATION_ERROR",
      422,
      "Schedule must end after it starts and fit at least one slot",
    );
  }

  Object.assign(schedule, input);
  await schedule.save();
  await invalidateDoctorSlotsCache(doctorId);

  return schedule;
}

// ===== Delete =====

export async function deleteSchedule(
  scheduleId: string,
  userId: string,
): Promise<void> {
  const doctorId = await getDoctorIdByUserId(userId);

  const schedule = await Schedule.findById(scheduleId);
  if (!schedule) throw new AppError("NOT_FOUND", 404, "Schedule not found");

  if (schedule.doctorId.toString() !== doctorId) {
    throw new AppError("FORBIDDEN", 403, "Not your schedule");
  }

  await schedule.deleteOne();
  await invalidateDoctorSlotsCache(doctorId);
}
