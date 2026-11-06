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
import { lockService } from "../../services/lock.service";
import { wsEmit } from "../../services/websocket.service";
import {
  getExpirationQueue,
  getNotificationQueue,
} from "../../workers/queue.definitions";
import { logger } from "../../config/logger";
import { clinicDateTimeToUtc, toDateString } from "../../utils/clinic-time";

const PAYMOB_TIMEOUT_MS = 15000;

// Every Paymob call goes through here so none can hang a request forever
async function paymobFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const env = getEnv();
  try {
    return await fetch(`${env.PAYMOB_BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(PAYMOB_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error({ err, path }, "Paymob request failed");
    throw new AppError("PAYMENT_ERROR", 502, "Payment provider unreachable");
  }
}

// ===== Step 1: Authenticate → get auth token =====
async function getAuthToken(): Promise<string> {
  const env = getEnv();

  const res = await paymobFetch("/auth/tokens", {
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
  const res = await paymobFetch("/ecommerce/orders", {
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
  expirationSeconds: number,
  billingData: {
    first_name: string;
    last_name: string;
    email: string;
    phone_number: string;
  },
): Promise<string> {
  const env = getEnv();

  const res = await paymobFetch("/acceptance/payment_keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_token: authToken,
      amount_cents: amountCents,
      expiration: expirationSeconds,
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

  // The expiry job may not have fired yet; don't take money for a hold that
  // has already run out
  const msLeft = appointment.expiresAt.getTime() - Date.now();
  if (msLeft <= 0) {
    throw new AppError("APPOINTMENT_EXPIRED", 400, "Appointment hold expired");
  }

  const [doctor, patient] = await Promise.all([
    Doctor.findById(appointment.doctorId),
    User.findById(patientId),
  ]);

  if (!doctor) throw new AppError("NOT_FOUND", 404, "Doctor not found");
  if (!patient) throw new AppError("NOT_FOUND", 404, "Patient not found");

  // Reuse the amount of an existing order (fees may have changed since);
  // Paymob needs an integer, and 99.99 * 100 is 9998.999... in floating point
  const amountCents = appointment.amountCents ?? Math.round(doctor.fees * 100);
  if (amountCents <= 0) {
    throw new AppError(
      "INVALID_AMOUNT",
      400,
      "This appointment has no payable amount",
    );
  }

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

  // One Paymob order per appointment. Calling this endpoint again must not
  // create a second order (and overwrite the id a first payment will report
  // back on), so an existing order is reused: only a new payment key is made.
  let paymobOrderId = appointment.paymentIntentId;
  if (!paymobOrderId) {
    const created = await createOrder(authToken, amountCents, appointmentId);
    // Compare-and-set: if a parallel request stored its order first, use theirs
    const claimed = await Appointment.findOneAndUpdate(
      {
        _id: appointment._id,
        status: AppointmentStatus.PENDING,
        $or: [
          { paymentIntentId: { $exists: false } },
          { paymentIntentId: null },
        ],
      },
      { paymentIntentId: created, amountCents },
      { new: true },
    );
    if (claimed) {
      paymobOrderId = created;
    } else {
      const fresh = await Appointment.findById(appointmentId);
      if (!fresh || fresh.status !== AppointmentStatus.PENDING) {
        throw new AppError("INVALID_STATUS", 400, "Appointment is not pending");
      }
      paymobOrderId = fresh.paymentIntentId ?? created;
    }
  }

  // The payment key must not outlive the appointment hold
  const expirationSeconds = Math.min(
    3600,
    Math.max(60, Math.ceil(msLeft / 1000)),
  );
  const paymentToken = await createPaymentKey(
    authToken,
    paymobOrderId,
    amountCents,
    expirationSeconds,
    billingData,
  );

  const env = getEnv();
  const iframeUrl = `${env.PAYMOB_BASE_URL}/acceptance/iframes/${env.PAYMOB_IFRAME_ID}?payment_token=${paymentToken}`;

  return { iframeUrl, paymobOrderId };
}

// Loosely typed on purpose: this is untrusted input until the HMAC checks out
export interface PaymobWebhookPayload {
  obj: {
    id: number;
    success: boolean;
    amount_cents: number;
    currency: string;
    order: {
      id: number;
      merchant_order_id?: string;
    };
    is_refund?: boolean;
    is_refunded?: boolean;
    is_void?: boolean;
    is_voided?: boolean;
    pending: boolean;
    error_occured: boolean;
    [key: string]: unknown;
  };
}

// Fields Paymob signs for a transaction callback, in lexicographic order.
// Source: Paymob docs, "HMAC — Transaction Processed Callback".
const PAYMOB_HMAC_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
];

function pick(obj: unknown, path: string): string {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[part];
  }
  // Paymob concatenates the raw values: missing/null become empty strings
  return cur === undefined || cur === null ? "" : String(cur);
}

// HMAC verification — بيتحقق إن الـ webhook فعلاً جاي من Paymob
export function verifyPaymobHmac(
  payload: PaymobWebhookPayload,
  hmacFromQuery: string,
): boolean {
  const env = getEnv();
  if (!payload || typeof payload.obj !== "object" || payload.obj === null) {
    return false;
  }

  const hmacString = PAYMOB_HMAC_FIELDS.map((f) => pick(payload.obj, f)).join(
    "",
  );

  const computed = crypto
    .createHmac("sha512", env.PAYMOB_HMAC_SECRET)
    .update(hmacString)
    .digest("hex");

  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(String(hmacFromQuery).toLowerCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  if (obj.order?.id === undefined || obj.id === undefined) {
    throw new AppError("WEBHOOK_INVALID", 400, "Malformed webhook payload");
  }

  // The appointment is looked up by the Paymob ORDER id, which is covered by
  // the HMAC. merchant_order_id is NOT signed, so it must never decide which
  // appointment gets confirmed.
  const orderId = String(obj.order.id);

  const isRefund = obj.is_refund === true || obj.is_refunded === true;
  const isVoid = obj.is_void === true || obj.is_voided === true;

  // 2. Handle transaction
  if (isRefund) {
    if (obj.success === true) await onRefundSucceeded(orderId);
  } else if (isVoid) {
    logger.warn({ orderId }, "Paymob void callback ignored");
  } else if (obj.success === true && obj.pending !== true) {
    await onPaymentSucceeded(orderId, obj);
  }
}

async function onPaymentSucceeded(
  orderId: string,
  obj: PaymobWebhookPayload["obj"],
): Promise<void> {
  const appointment = await Appointment.findOne({ paymentIntentId: orderId });
  if (!appointment) {
    logger.warn({ orderId }, "Payment webhook for unknown Paymob order");
    return;
  }
  const appointmentId = appointment._id.toString();
  const transactionId = String(obj.id);

  // The money received must match what we asked for
  if (
    (appointment.amountCents !== undefined &&
      Number(obj.amount_cents) !== appointment.amountCents) ||
    obj.currency !== "EGP"
  ) {
    logger.error(
      {
        appointmentId,
        expected: appointment.amountCents,
        received: obj.amount_cents,
        currency: obj.currency,
      },
      "Paymob payment does not match the order amount; not confirming",
    );
    return;
  }

  // Atomic pending → confirmed. A concurrent expiry/cancel/duplicate webhook
  // cannot be overwritten, and only one caller wins the side effects.
  const confirmed = await Appointment.findOneAndUpdate(
    { _id: appointment._id, status: AppointmentStatus.PENDING },
    {
      status: AppointmentStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      paymentTransactionId: transactionId,
      confirmedAt: new Date(),
    },
    { new: true },
  );

  if (!confirmed) {
    // Not pending any more. If it was already confirmed this is a duplicate
    // callback. If it expired/was cancelled meanwhile, the customer's money
    // is taken for an appointment that no longer exists: record it and refund.
    const current = await Appointment.findById(appointment._id);
    if (
      current &&
      (current.status === AppointmentStatus.EXPIRED ||
        current.status === AppointmentStatus.CANCELLED)
    ) {
      const marked = await Appointment.findOneAndUpdate(
        { _id: current._id, paymentStatus: PaymentStatus.UNPAID },
        {
          paymentStatus: PaymentStatus.PAID,
          paymentTransactionId: transactionId,
        },
        { new: true },
      );
      if (marked) {
        logger.warn(
          { appointmentId },
          "Payment arrived for a dead appointment; refunding",
        );
        try {
          await refundPaidAppointment(appointmentId);
        } catch (err) {
          // Stays PAID so the admin refund endpoint can retry
          logger.error({ err, appointmentId }, "Auto-refund failed");
        }
      }
    }
    return;
  }

  // Invalidate slots cache for the doctor
  await cacheService.invalidateDoctorSlots(confirmed.doctorId.toString());

  // Remove BullMQ expiry job (best effort: the expiry worker is idempotent)
  try {
    const job = await getExpirationQueue().getJob(appointmentId);
    if (job) await job.remove();
  } catch (err) {
    logger.warn({ err, appointmentId }, "Could not remove expiry job");
  }

  // WebSocket
  wsEmit.appointmentConfirmed(confirmed.patientId.toString(), appointmentId);

  // Notification (deterministic jobId: a replayed webhook can't double-send)
  await getNotificationQueue().add(
    NotificationType.APPOINTMENT_CONFIRMED,
    {
      type: NotificationType.APPOINTMENT_CONFIRMED,
      appointmentId,
      userId: confirmed.patientId.toString(),
    },
    {
      jobId: `confirmed-${appointmentId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    },
  );

  // Schedule 24h reminder. startTime is a clinic wall-clock time, so convert it
  // with the clinic timezone (not UTC) to get the real instant.
  const startsAt = clinicDateTimeToUtc(
    toDateString(confirmed.date),
    confirmed.startTime,
  );
  const reminderDelay = startsAt.getTime() - Date.now() - 24 * 60 * 60 * 1000;

  if (reminderDelay > 0) {
    await getNotificationQueue().add(
      NotificationType.APPOINTMENT_REMINDER,
      {
        type: NotificationType.APPOINTMENT_REMINDER,
        appointmentId,
        userId: confirmed.patientId.toString(),
      },
      {
        jobId: `reminder-${appointmentId}`,
        delay: reminderDelay,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
      },
    );
  }

  logger.info({ appointmentId }, "Payment confirmed via Paymob");
}

async function onRefundSucceeded(orderId: string): Promise<void> {
  const res = await Appointment.updateOne(
    { paymentIntentId: orderId, paymentStatus: PaymentStatus.PAID },
    { paymentStatus: PaymentStatus.REFUNDED },
  );
  if (res.modifiedCount > 0) {
    logger.info({ orderId }, "Refund confirmed via Paymob");
  }
}

// ===== Refund =====

// [admin] manual refund (also the retry path when an automatic refund failed)
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

  await refundPaidAppointment(appointmentId);
}

// Documented transaction inquiry: used only for appointments confirmed before
// the transaction id was stored on the appointment.
async function inquireTransaction(
  authToken: string,
  orderId: string,
): Promise<{ id: number; amount_cents: number }> {
  const res = await paymobFetch("/ecommerce/orders/transaction_inquiry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth_token: authToken, order_id: orderId }),
  });
  if (!res.ok) {
    throw new AppError("REFUND_FAILED", 502, "Could not look up the payment");
  }
  const tx = (await res.json()) as {
    id?: number;
    success?: boolean;
    amount_cents?: number;
  };
  if (!tx.id || tx.success !== true || typeof tx.amount_cents !== "number") {
    throw new AppError("REFUND_FAILED", 502, "No successful payment found");
  }
  return { id: tx.id, amount_cents: tx.amount_cents };
}

/**
 * Refunds a PAID appointment exactly once. Serialised per appointment with a
 * lock and re-checked inside it, so concurrent cancels / admin double-clicks
 * can never send two refund requests. Returns false if it was already refunded.
 * Throws if Paymob rejects the refund (the appointment then stays PAID so the
 * refund can be retried instead of being silently marked REFUNDED).
 */
export async function refundPaidAppointment(
  appointmentId: string,
): Promise<boolean> {
  return lockService.withLock(
    `lock:refund:${appointmentId}`,
    30000,
    async () => {
      const appointment = await Appointment.findById(appointmentId);
      if (!appointment || appointment.paymentStatus !== PaymentStatus.PAID) {
        return false;
      }
      if (!appointment.paymentIntentId) {
        throw new AppError("NO_PAYMENT_ID", 400, "No Paymob order ID found");
      }

      const authToken = await getAuthToken();

      let transactionId: string | number | undefined =
        appointment.paymentTransactionId;
      let amountCents = appointment.amountCents;
      if (!transactionId || amountCents === undefined) {
        const tx = await inquireTransaction(
          authToken,
          appointment.paymentIntentId,
        );
        transactionId = transactionId ?? tx.id;
        amountCents = amountCents ?? tx.amount_cents;
      }

      const res = await paymobFetch("/acceptance/void_refund/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_token: authToken,
          transaction_id: Number(transactionId),
          amount_cents: amountCents,
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        success?: unknown;
      };
      if (!res.ok || body.success === false || body.success === "false") {
        logger.error(
          { appointmentId, status: res.status },
          "Paymob refund request failed",
        );
        throw new AppError(
          "REFUND_FAILED",
          502,
          "Paymob refund request failed",
        );
      }

      await Appointment.updateOne(
        { _id: appointment._id, paymentStatus: PaymentStatus.PAID },
        { paymentStatus: PaymentStatus.REFUNDED },
      );

      logger.info(
        { appointmentId, transactionId },
        "Refund requested via Paymob",
      );
      return true;
    },
    10,
    50,
  );
}
