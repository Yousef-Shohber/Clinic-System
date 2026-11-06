import mongoose, { Document, Schema } from "mongoose";
import { AppointmentStatus, PaymentStatus } from "../types/enums";
import getEnv from "../config/env";

export interface IAppointment extends Document {
  _id: mongoose.Types.ObjectId;
  doctorId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  scheduleId: mongoose.Types.ObjectId;
  date: Date;
  startTime: string; // "09:00"
  endTime: string; // "09:30"
  status: AppointmentStatus;
  paymentStatus: PaymentStatus;
  paymentIntentId?: string; // Paymob order id
  paymentTransactionId?: string; // Paymob transaction id (needed for refunds)
  amountCents?: number; // amount the Paymob order was created with
  patientNotes?: string;
  doctorNotes?: string;
  expiresAt: Date;
  confirmedAt?: Date;
  cancelledAt?: Date;
}

const appointmentSchema = new Schema<IAppointment>(
  {
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },
    patientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    scheduleId: {
      type: Schema.Types.ObjectId,
      ref: "Schedule",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      required: true,
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, "Invalid time format, use HH:MM"],
    },
    endTime: {
      type: String,
      required: true,
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, "Invalid time format, use HH:MM"],
    },
    status: {
      type: String,
      enum: Object.values(AppointmentStatus),
      default: AppointmentStatus.PENDING,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PaymentStatus),
      default: PaymentStatus.UNPAID,
    },
    paymentIntentId: {
      type: String,
    },
    paymentTransactionId: {
      type: String,
    },
    amountCents: {
      type: Number,
      min: 0,
    },
    patientNotes: {
      type: String,
      maxlength: 500,
    },
    // select: false — مش بيتبعت للـ patient تلقائياً
    // الـ doctor/admin بيعملوا .select("+doctorNotes") صراحة
    doctorNotes: {
      type: String,
      maxlength: 1000,
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => {
        const env = getEnv();
        return new Date(
          Date.now() + env.APPOINTMENT_EXPIRY_MINUTES * 60 * 1000,
        );
      },
    },
    confirmedAt: {
      type: Date,
    },
    cancelledAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const ACTIVE_SLOT_STATUSES = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.COMPLETED,
];

appointmentSchema.index(
  { doctorId: 1, date: 1, startTime: 1 },
  {
    unique: true,
    name: "active_slot_unique",
    partialFilterExpression: { status: { $in: ACTIVE_SLOT_STATUSES } },
  },
);

// للـ query بتاع "appointments بتاعتي" مع filter بالـ status
appointmentSchema.index({ patientId: 1, status: 1 });

// NOT a TTL index any more: a TTL index *deletes* the document (history, payment
// reference and the "expired" notification all vanish). Overdue pending
// appointments are now marked EXPIRED by the sweeper in expiration.worker.ts,
// which uses this index.
appointmentSchema.index(
  { expiresAt: 1 },
  {
    name: "pending_expiry_scan",
    partialFilterExpression: { status: AppointmentStatus.PENDING },
  },
);

// Webhook lookups by Paymob order id
appointmentSchema.index({ paymentIntentId: 1 }, { sparse: true });

export const Appointment = mongoose.model<IAppointment>(
  "Appointment",
  appointmentSchema,
);
