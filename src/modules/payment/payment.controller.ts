import { Request, Response } from "express";
import * as paymentService from "./payment.service";
import { storeIdempotentResponse } from "../../middleware/idempotency";

// [patient] Create payment session → returns iframe URL
export async function createPaymentSession(
  req: Request,
  res: Response,
): Promise<void> {
  const { appointmentId } = req.params as { appointmentId: string };
  const { iframeUrl, paymobOrderId } =
    await paymentService.createPaymentSession(appointmentId, req.user.userId);

  const responseData = { success: true, data: { iframeUrl, paymobOrderId } };

  if (res.locals.idempotencyKey) {
    await storeIdempotentResponse(
      res.locals.idempotencyKey as string,
      responseData,
      res.locals.idempotencyFingerprint as string | undefined,
    );
  }

  res.status(200).json(responseData);
}

// [paymob] Webhook — POST callback من Paymob بعد الدفع
// الـ HMAC بييجي في الـ query string مش في الـ body
export async function paymobWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const hmac = req.query["hmac"] as string | undefined;

  if (!hmac) {
    res.status(400).json({
      success: false,
      error: { code: "MISSING_HMAC", message: "Missing HMAC in query" },
    });
    return;
  }

  await paymentService.handlePaymobWebhook(
    req.body as paymentService.PaymobWebhookPayload,
    hmac,
  );

  // Paymob بيحتاج 200 بسرعة
  res.status(200).json({ received: true });
}

// [admin] Manual refund
export async function refundAppointment(
  req: Request,
  res: Response,
): Promise<void> {
  const { appointmentId } = req.params as { appointmentId: string };
  await paymentService.refundAppointment(appointmentId);
  res
    .status(200)
    .json({ success: true, message: "Refund processed successfully" });
}
