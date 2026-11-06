import { z } from "zod";
import logger from "./logger";

const envSchema = z.object({
  // App
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.string().default("8000").transform(Number),
  CLIENT_URL: z.string().url(),
  CORS_ORIGINS: z.string().transform((val) =>
    val
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ),

  // Database
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  COOKIE_SECRET: z.string().min(32),

  // Email
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.string().default("587").transform(Number),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  EMAIL_FROM: z.string().email(),

  // OTP
  OTP_LENGTH: z.string().default("6").transform(Number),
  OTP_EXPIRES_MINUTES: z.string().default("10").transform(Number),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().url(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // Paymob
  PAYMOB_API_KEY: z.string().min(1),
  PAYMOB_INTEGRATION_ID: z.string().min(1),
  PAYMOB_IFRAME_ID: z.string().min(1),
  PAYMOB_HMAC_SECRET: z.string().min(1),
  PAYMOB_BASE_URL: z.string().url().default("https://accept.paymob.com/api"),

  // Config
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  BCRYPT_ROUNDS: z.string().default("12").transform(Number),
  APPOINTMENT_EXPIRY_MINUTES: z.string().default("15").transform(Number),
  CACHE_TTL_SECONDS: z.string().default("60").transform(Number),
  LOCK_TTL_MS: z.string().default("10000").transform(Number),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().default(86400),
  CLINIC_TIMEZONE: z
    .string()
    .default("Africa/Cairo")
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid IANA timezone" },
    ),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env;

export function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    logger.error("Invalid environment variables:");
    logger.error(result.error.format());
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) return parseEnv();
  return _env;
}

export default getEnv;
