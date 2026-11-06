import { Review } from "../../models/review.model";
import { Appointment } from "../../models/appointment.model";
import { AppError } from "../../types/errors";
import { AppointmentStatus, Role } from "../../types/enums";
import { cacheService, REDIS_KEYS } from "../../services/cache.service";
import {
  CreateReviewDtoType,
  UpdateReviewDtoType,
  ListReviewsDtoType,
} from "./review.schema";

// ===== Create Review =====

export async function createReview(
  patientId: string,
  input: CreateReviewDtoType,
) {
  const appointment = await Appointment.findById(input.appointmentId);

  if (!appointment) {
    throw new AppError("NOT_FOUND", 404, "Appointment not found");
  }

  if (appointment.patientId.toString() !== patientId) {
    throw new AppError("FORBIDDEN", 403, "Not your appointment");
  }

  if (appointment.status !== AppointmentStatus.COMPLETED) {
    throw new AppError(
      "INVALID_STATUS",
      400,
      "Can only review completed appointments",
    );
  }

  const existing = await Review.findOne({ appointmentId: input.appointmentId });
  if (existing) {
    throw new AppError(
      "REVIEW_EXISTS",
      409,
      "You already reviewed this appointment",
    );
  }

  const review = await Review.create({
    doctorId: appointment.doctorId,
    patientId,
    appointmentId: input.appointmentId,
    rating: input.rating,
    comment: input.comment,
  });

  // Invalidate doctor profile cache عشان الـ rating اتغير
  await cacheService.del(
    REDIS_KEYS.doctorProfile(appointment.doctorId.toString()),
  );

  return review;
}

// ===== Get Doctor Reviews =====

export async function getDoctorReviews(
  doctorId: string,
  query: ListReviewsDtoType,
) {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    Review.find({ doctorId })
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1, _id: -1 })
      .populate("patientId", "name profilePhoto")
      .lean(),
    Review.countDocuments({ doctorId }),
  ]);

  return {
    reviews,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ===== Update Review =====

export async function updateReview(
  reviewId: string,
  patientId: string,
  input: UpdateReviewDtoType,
) {
  const review = await Review.findById(reviewId);
  if (!review) throw new AppError("NOT_FOUND", 404, "Review not found");

  if (review.patientId.toString() !== patientId) {
    throw new AppError("FORBIDDEN", 403, "Not your review");
  }

  Object.assign(review, input);
  await review.save(); // post-save hook بيعمل recalculate تلقائياً

  await cacheService.del(REDIS_KEYS.doctorProfile(review.doctorId.toString()));

  return review;
}

// ===== Delete Review =====

export async function deleteReview(
  reviewId: string,
  userId: string,
  role: Role,
) {
  const review = await Review.findById(reviewId);
  if (!review) throw new AppError("NOT_FOUND", 404, "Review not found");

  if (role === Role.PATIENT && review.patientId.toString() !== userId) {
    throw new AppError("FORBIDDEN", 403, "Not your review");
  }

  // بنستخدم findOneAndDelete عشان يشغل الـ post hook في الـ model
  await Review.findOneAndDelete({ _id: reviewId });

  await cacheService.del(REDIS_KEYS.doctorProfile(review.doctorId.toString()));
}
