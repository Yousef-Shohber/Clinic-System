import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { Role } from "../../types/enums";
import { validate } from "../../middleware/validate";
import { ListUsersDto } from "./admin.schema";
import * as controller from "./admin.controller";

const router = Router();

router.use(authenticate, authorize(Role.ADMIN));

router.get("/stats", asyncHandler(controller.getStats));
router.get(
  "/users",
  validate(ListUsersDto, "query"),
  asyncHandler(controller.listUsers),
);
router.get("/doctors/pending", asyncHandler(controller.getPendingDoctors));

export default router;
