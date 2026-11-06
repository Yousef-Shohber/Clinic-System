import { z } from "zod";
import { isValidCalendarDate } from "../../utils/clinic-time";

export const createDoctorSchema = z.object({
  doctorName: z.string().min(2).max(100).trim(),
  specialization: z.string().min(2).max(100).trim(),
  bio: z.string().min(10).max(1000).trim(),
  fees: z.number().min(0),
  experience: z.number().min(0).max(100),
});

export const updateDoctorSchema = z.object({
  doctorName: z.string().min(2).max(100).trim().optional(),
  specialization: z.string().min(2).max(100).trim().optional(),
  bio: z.string().min(10).max(1000).trim().optional(),
  fees: z.number().min(0).optional(),
  experience: z.number().min(0).max(100).optional(),
});

export const listDoctorsQuerySchema = z.object({
  search: z.string().optional(),
  specialization: z.string().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  maxFees: z.coerce.number().min(0).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(10),
});

export const verifyDoctorSchema = z.object({
  isVerified: z.boolean(),
});

export const getSlotsQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isValidCalendarDate, { message: "Invalid calendar date" }),
});

export type CreateDoctorInput = z.infer<typeof createDoctorSchema>;
export type UpdateDoctorInput = z.infer<typeof updateDoctorSchema>;
export type ListDoctorsQuery = z.infer<typeof listDoctorsQuerySchema>;
export type VerifyDoctorInput = z.infer<typeof verifyDoctorSchema>;
export type GetSlotsQuery = z.infer<typeof getSlotsQuerySchema>;
