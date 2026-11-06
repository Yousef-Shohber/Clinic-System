import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { v4 as uuidv4 } from "uuid";
import passport from "passport";
import getEnv from "./config/env";
import { logger } from "./config/logger";
import { getDatabaseStatus } from "./config/database";
import { getRedisStatus } from "./config/redis";
import { initPassport } from "./config/passport";
import { errorHandler } from "./middleware/error-handler";
import { createRateLimiter } from "./middleware/rate-limit";

// Routes
import authRoutes from "./modules/auth/auth.routes";
import doctorRoutes from "./modules/doctor/doctor.routes";
import scheduleRoutes from "./modules/schedule/schedule.routes";
import appointmentRoutes from "./modules/appointment/appointment.routes";
import paymentRoutes from "./modules/payment/payment.routes";
import reviewRoutes from "./modules/review/review.routes";
import adminRoutes from "./modules/admin/admin.routes";

export function createApp() {
  const app = express();
  const env = getEnv();

  initPassport();

  // ===== Security =====
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    }),
  );

  // ===== Body Parsing =====
  app.use(express.json({ limit: "10kb" }));
  app.use(cookieParser(env.COOKIE_SECRET));

  // ===== Passport =====
  app.use(passport.initialize());

  // ===== Logging =====
  app.use(
    pinoHttp({
      logger,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.token",
      ],
    }),
  );

  // ===== Request ID =====
  app.use((req: Request, res: Response, next) => {
    const requestId = uuidv4();
    req.requestId = requestId;
    res.set("X-Request-ID", requestId);
    next();
  });

  // ===== Rate Limiting =====
  app.use("/api/v1/auth", createRateLimiter({ max: 5, windowMs: 60_000 }));
  app.use(
    createRateLimiter({
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
    }),
  );

  // ===== Routes =====
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/doctors", doctorRoutes);
  app.use("/api/v1/schedules", scheduleRoutes);
  app.use("/api/v1/appointments", appointmentRoutes);
  app.use("/api/v1/payments", paymentRoutes);
  app.use("/api/v1/reviews", reviewRoutes);
  app.use("/api/v1/admin", adminRoutes);

  // ===== Health Check =====
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        status: "ok",
        database: getDatabaseStatus(),
        redis: getRedisStatus(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
    });
  });

  // ===== 404 =====
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  // ===== Global Error Handler =====
  app.use(errorHandler);

  return app;
}
