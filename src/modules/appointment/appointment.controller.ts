import { Request, Response } from "express";
import * as appointmentService from "./appointment.service";
import { Role } from "../../types/enums";
import { storeIdempotentResponse } from "../../middleware/idempotency";

export async function createAppointment(
  req: Request,
  res: Response,
): Promise<void> {
  const appointment = await appointmentService.createAppointment(
    req.user.userId,
    req.body,
  );

  const responseData = { success: true, data: { appointment } };

  if (res.locals.idempotencyKey) {
    await storeIdempotentResponse(
      res.locals.idempotencyKey,
      responseData,
      res.locals.idempotencyFingerprint,
    );
  }

  res.status(201).json(responseData);
}

export async function getMyAppointments(
  req: Request,
  res: Response,
): Promise<void> {
  const result = await appointmentService.getMyAppointments(
    req.user.userId,
    req.user.role,
    req.query as any,
  );
  res.status(200).json({ success: true, data: result });
}

export async function getAllAppointments(
  req: Request,
  res: Response,
): Promise<void> {
  const result = await appointmentService.getAllAppointments(req.query as any);
  res.status(200).json({ success: true, data: result });
}

export async function getAppointmentById(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params as { id: string };
  const appointment = await appointmentService.getAppointmentById(
    id,
    req.user.userId,
    req.user.role,
  );
  res.status(200).json({ success: true, data: { appointment } });
}

export async function cancelAppointment(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params as { id: string };
  const appointment = await appointmentService.cancelAppointment(
    id,
    req.user.userId,
    req.user.role,
  );
  res.status(200).json({ success: true, data: { appointment } });
}

export async function completeAppointment(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params as { id: string };
  const appointment = await appointmentService.completeAppointment(
    id,
    req.user.userId,
    req.body,
  );
  res.status(200).json({ success: true, data: { appointment } });
}
