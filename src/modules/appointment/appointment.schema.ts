import { z } from "zod";
import { AppointmentStatus } from "../../types/enums";
import { clinicToday, isValidCalendarDate } from "../../utils/clinic-time";

export const CreateAppointmentDto = z.object({
  doctorId: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isValidCalendarDate, { message: "Invalid calendar date" })
    .refine(
      (d) => d >= clinicToday(), // "today" at the clinic, not in UTC
      { message: "Cannot book appointments in the past" },
    ),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Invalid time HH:MM"),
  patientNotes: z.string().max(500).optional(),
});

export const ListMyAppointmentsDto = z.object({
  status: z.nativeEnum(AppointmentStatus).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(10),
});

export const ListAllAppointmentsDto = z.object({
  status: z.nativeEnum(AppointmentStatus).optional(),
  doctorId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid doctor id")
    .optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidCalendarDate, { message: "Invalid calendar date" })
    .optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(10),
});

export const CompleteAppointmentDto = z.object({
  doctorNotes: z.string().max(1000).optional(),
});

export type CreateAppointmentDtoType = z.infer<typeof CreateAppointmentDto>;
export type ListMyAppointmentsDtoType = z.infer<typeof ListMyAppointmentsDto>;
export type ListAllAppointmentsDtoType = z.infer<typeof ListAllAppointmentsDto>;
export type CompleteAppointmentDtoType = z.infer<typeof CompleteAppointmentDto>;
