import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { idempotency } from "../../middleware/idempotency";
import { Role } from "../../types/enums";
import * as controller from "./payment.controller";

const router = Router();

// [patient] Create Paymob payment session → iframeUrl
router.post(
  "/create-session/:appointmentId",
  authenticate,
  authorize(Role.PATIENT),
  idempotency(),
  asyncHandler(controller.createPaymentSession),
);

// [paymob] Webhook — بدون authenticate، Paymob بيوقع بالـ HMAC
// HMAC بييجي في query string: ?hmac=...
router.post("/webhook", asyncHandler(controller.paymobWebhook));

// [admin] Manual refund
router.post(
  "/refund/:appointmentId",
  authenticate,
  authorize(Role.ADMIN),
  asyncHandler(controller.refundAppointment),
);

export default router;
