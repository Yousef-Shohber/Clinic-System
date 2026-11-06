import { Request, Response } from "express";
import * as adminService from "./admin.service";
import { Role } from "../../types/enums";

export async function getStats(_req: Request, res: Response): Promise<void> {
  const stats = await adminService.getStats();
  res.status(200).json({ success: true, data: stats });
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  // validated + coerced by validate(ListUsersDto, "query") in the route
  const { role, page, limit } = req.query as unknown as {
    role?: Role;
    page: number;
    limit: number;
  };

  const result = await adminService.listUsers({ role, page, limit });

  res.status(200).json({ success: true, data: result });
}

export async function getPendingDoctors(
  _req: Request,
  res: Response,
): Promise<void> {
  const doctors = await adminService.getPendingDoctors();
  res.status(200).json({ success: true, data: { doctors } });
}
