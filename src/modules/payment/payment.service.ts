import crypto from "crypto";
import getEnv from "../../config/env";
import { Appointment } from "../../models/appointment.model";
import { Doctor } from "../../models/doctor.model";
import { User } from "../../models/user.model";
import { AppError } from "../../types/errors";
import {
  AppointmentStatus,
  PaymentStatus,
  NotificationType,
} from "../../types/enums";
import { cacheService, REDIS_KEYS } from "../../services/cache.service";
import { wsEmit } from "../../services/websocket.service";
import {
  getExpirationQueue,
  getNotificationQueue,
} from "../../workers/queue.definitions";
import { logger } from "../../config/logger";

const PAYMOB_BASE_URL = "https://accept.paymob.com/api";

// ===== Step 1: Authenticate → get auth token =====
async function getAuthToken(): Promise<string> {
  const env = getEnv();

  const res = await fetch(`${PAYMOB_BASE_URL}/auth/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: env.PAYMOB_API_KEY,
    }),
  });

  if (!res.ok) {
    throw new AppError("PAYMENT_ERROR", 500, "Paymob authentication failed");
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

// ===== Step 2: Create Order =====
async function createOrder(
  authToken: string,
  amountCents: number,
  merchantOrderId: string,
): Promise<string> {
  const res = await fetch(`${PAYMOB_BASE_URL}/ecommerce/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_token: authToken,
      delivery_needed: false,
      amount_cents: amountCents,
      currency: "EGP",
      merchant_order_id: merchantOrderId,
      items: [],
    }),
  });

  if (!res.ok) {
    throw new AppError("PAYMENT_ERROR", 500, "Failed to create Paymob order");
  }

  const data = (await res.json()) as { id: number };
  return data.id.toString();
}

// ===== Step 3: Create Payment Key =====
async function createPaymentKey(
  authToken: string,
  orderId: string,
  amountCents: number,
  billingData: {
    first_name: string;
    last_name: string;
    email: string;
    phone_number: string;
  },
): Promise<string> {
  const env = getEnv();

  const res = await fetch(`${PAYMOB_BASE_URL}/acceptance/payment_keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_token: authToken,
      amount_cents: amountCents,
      expiration: 3600,
      order_id: orderId,
      billing_data: billingData,
      currency: "EGP",
      integration_id: env.PAYMOB_INTEGRATION_ID,
      lock_order_when_paid: true,
      redirect_url: `${env.CLIENT_URL}/payment/callback`,
    }),
  });

  if (!res.ok) {
    throw new AppError("PAYMENT_ERROR", 500, "Failed to create payment key");
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

// ===== Main: Create Payment Session =====

export async function createPaymentSession(
  appointmentId: string,
  patientId: string,
): Promise<{ iframeUrl: string; paymobOrderId: string }> {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment)
    throw new AppError("NOT_FOUND", 404, "Appointment not found");

  if (appointment.patientId.toString() !== patientId) {
    throw new AppError("FORBIDDEN", 403, "Not your appointment");
  }

  if (appointment.status !== AppointmentStatus.PENDING) {
    throw new AppError("INVALID_STATUS", 400, "Appointment is not pending");
  }

  const [doctor, patient] = await Promise.all([
    Doctor.findById(appointment.doctorId),
    User.findById(patientId),
  ]);

  if (!doctor) throw new AppError("NOT_FOUND", 404, "Doctor not found");
  if (!patient) throw new AppError("NOT_FOUND", 404, "Patient not found");

  const amountCents = doctor.fees * 100;

  // Split name into first + last (fallback if single word)
  const nameParts = patient.name.split(" ");
  const firstName = nameParts[0] ?? patient.name;
  const lastName = nameParts.slice(1).join(" ") || "N/A";

  const billingData = {
    first_name: firstName,
    last_name: lastName,
    email: patient.email,
    phone_number: "N/A",
    apartment: "N/A",
    floor: "N/A",
    street: "N/A",
    building: "N/A",
    shipping_method: "N/A",
    postal_code: "N/A",
    city: "N/A",
    country: "EG",
    state: "N/A",
  };

  // Paymob 3-step flow
  const authToken = await getAuthToken();
  const paymobOrderId = await createOrder(
    authToken,
    amountCents,
    appointmentId,
  );
  const paymentToken = await createPaymentKey(
    authToken,
    paymobOrderId,
    amountCents,
    billingData,
  );

  appointment.paymentIntentId = paymobOrderId;
  await appointment.save();

  const env = getEnv();
  const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${env.PAYMOB_IFRAME_ID}?payment_token=${paymentToken}`;

  return { iframeUrl, paymobOrderId };
}

export interface PaymobWebhookPayload {
  obj: {
    id: number;
    success: boolean;
    amount_cents: number;
    currency: string;
    order: {
      id: number;
      merchant_order_id: string;
    };
    is_refund: boolean;
    is_void: boolean;
    pending: boolean;
    error_occured: boolean;
  };
  hmac: string;
}

// HMAC verification — بيتحقق إن الـ webhook فعلاً جاي من Paymob
export function verifyPaymobHmac(
  payload: PaymobWebhookPayload,
  hmacFromQuery: string,
): boolean {
  const env = getEnv();
  const obj = payload.obj;

  // الـ fields اللي Paymob بيحسب HMAC عليها بالترتيب ده بالظبط
  const hmacString = [
    obj.amount_cents,
    obj.order.id,
    obj.currency,
    obj.error_occured,
    obj.id,
    obj.pending,
    obj.is_refund,
    obj.is_void,
    obj.success,
  ]
    .map(String)
    .join("");

  const computed = crypto
    .createHmac("sha512", env.PAYMOB_HMAC_SECRET)
    .update(hmacString)
    .digest("hex");

  return computed === hmacFromQuery;
}

export async function handlePaymobWebhook(
  payload: PaymobWebhookPayload,
  hmacFromQuery: string,
): Promise<void> {
  // 1. Verify HMAC
  if (!verifyPaymobHmac(payload, hmacFromQuery)) {
    throw new AppError("WEBHOOK_INVALID", 400, "Invalid Paymob HMAC signature");
  }

  const obj = payload.obj;

  // 2. Handle transaction
  if (obj.success && !obj.is_refund && !obj.is_void) {
    await onPaymentSucceeded(obj.order.merchant_order_id);
  } else if (obj.is_refund) {
    await onRefundSucceeded(obj.order.merchant_order_id);
  }
}

async function onPaymentSucceeded(appointmentId: string): Promise<void> {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) return;
  if (appointment.status === AppointmentStatus.CONFIRMED) return;

  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.paymentStatus = PaymentStatus.PAID;
  appointment.confirmedAt = new Date();
  await appointment.save();

  // Invalidate slots cache for the doctor on that day
  const dateStr = appointment.date.toISOString().split("T")[0]!;
  await cacheService.del(
    REDIS_KEYS.doctorSlots(appointment.doctorId.toString(), dateStr),
  );

  // Remove BullMQ expiry job
  const job = await getExpirationQueue().getJob(appointmentId);
  if (job) await job.remove();

  // WebSocket
  wsEmit.appointmentConfirmed(appointment.patientId.toString(), appointmentId);

  // Notification
  await getNotificationQueue().add(
    NotificationType.APPOINTMENT_CONFIRMED,
    {
      type: NotificationType.APPOINTMENT_CONFIRMED,
      appointmentId,
      userId: appointment.patientId.toString(),
    },
    { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
  );

  // Schedule 24h reminder
  const appointmentDateTime = new Date(appointment.date);
  const [h, m] = appointment.startTime.split(":").map(Number);
  appointmentDateTime.setUTCHours(h!, m!, 0, 0);
  const reminderDelay =
    appointmentDateTime.getTime() - Date.now() - 24 * 60 * 60 * 1000;

  if (reminderDelay > 0) {
    await getNotificationQueue().add(
      NotificationType.APPOINTMENT_REMINDER,
      {
        type: NotificationType.APPOINTMENT_REMINDER,
        appointmentId,
        userId: appointment.patientId.toString(),
      },
      {
        delay: reminderDelay,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
      },
    );
  }

  logger.info({ appointmentId }, "Payment confirmed via Paymob");
}

async function onRefundSucceeded(appointmentId: string): Promise<void> {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) return;

  appointment.paymentStatus = PaymentStatus.REFUNDED;
  await appointment.save();

  logger.info({ appointmentId }, "Refund confirmed via Paymob");
}

// ===== Refund =====

export async function refundAppointment(appointmentId: string): Promise<void> {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment)
    throw new AppError("NOT_FOUND", 404, "Appointment not found");
  if (appointment.paymentStatus !== PaymentStatus.PAID) {
    throw new AppError("NOT_PAID", 400, "Appointment was not paid");
  }
  if (!appointment.paymentIntentId) {
    throw new AppError("NO_PAYMENT_ID", 400, "No Paymob order ID found");
  }

  await processRefund(appointment.paymentIntentId);
  appointment.paymentStatus = PaymentStatus.REFUNDED;
  await appointment.save();
}

// بتتاستخدم كمان من expiration worker و cancel flow
export async function processRefund(paymobOrderId: string): Promise<void> {
  const authToken = await getAuthToken();

  // Get transactions for this order
  const res = await fetch(
    `${PAYMOB_BASE_URL}/ecommerce/orders/${paymobOrderId}/transactions`,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    },
  );

  if (!res.ok) {
    logger.error(
      { paymobOrderId },
      "Failed to get Paymob transactions for refund",
    );
    throw new AppError("PAYMENT_ERROR", 500, "Failed to process refund");
  }

  const transactions = (await res.json()) as Array<{
    id: number;
    success: boolean;
    is_refund: boolean;
  }>;
  const successfulTx = transactions.find((t) => t.success && !t.is_refund);

  if (!successfulTx) {
    logger.warn({ paymobOrderId }, "No successful transaction found to refund");
    return;
  }

  // Refund request
  const refundRes = await fetch(
    `${PAYMOB_BASE_URL}/acceptance/void_refund/refund`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_token: authToken,
        transaction_id: successfulTx.id,
      }),
    },
  );

  if (!refundRes.ok) {
    throw new AppError("PAYMENT_ERROR", 500, "Paymob refund request failed");
  }

  logger.info(
    { paymobOrderId, transactionId: successfulTx.id },
    "Refund requested via Paymob",
  );
}
