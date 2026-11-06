import crypto from "crypto";
import getRedis from "../config/redis";
import getEnv from "../config/env";
import { AppError } from "../types/errors";

const MAX_OTP_ATTEMPTS = 5;

const VERIFY_OTP_SCRIPT = `
local stored = redis.call("GET", KEYS[1])
if not stored then return -1 end
if stored == ARGV[1] then
  redis.call("DEL", KEYS[1], KEYS[2])
  return 1
end
local n = redis.call("INCR", KEYS[2])
if n == 1 then
  local ttl = redis.call("PTTL", KEYS[1])
  if ttl > 0 then redis.call("PEXPIRE", KEYS[2], ttl) end
end
if n >= tonumber(ARGV[2]) then
  redis.call("DEL", KEYS[1], KEYS[2])
  return -2
end
return 0
`;

function generateOTP(): string {
  const env = getEnv();
  return crypto
    .randomInt(0, 10 ** env.OTP_LENGTH)
    .toString()
    .padStart(env.OTP_LENGTH, "0");
}

function hashOTP(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export async function createOTP(key: string) {
  const redis = getRedis();
  const env = getEnv();

  const otp = generateOTP();
  const hashedOtp = hashOTP(otp);
  const ttl = Number(env.OTP_EXPIRES_MINUTES * 60);

  await redis.set(key, hashedOtp, "EX", ttl);
  await redis.del(`${key}:attempts`);

  return otp;
}

export async function verifyOTP(key: string, otp: string) {
  const redis = getRedis();

  const result = (await redis.eval(
    VERIFY_OTP_SCRIPT,
    2,
    key,
    `${key}:attempts`,
    hashOTP(otp),
    MAX_OTP_ATTEMPTS.toString(),
  )) as number;

  if (result === 1) return true;
  if (result === -1) {
    throw new AppError("OTP_EXPIRED", 400, "OTP expired or not found");
  }
  if (result === -2) {
    throw new AppError(
      "OTP_ATTEMPTS_EXCEEDED",
      429,
      "Too many invalid attempts. Please request a new OTP",
    );
  }
  throw new AppError("INVALID_OTP", 400, "Invalid OTP");
}

/** Returns true if the caller may send now, false if still cooling down. */
export async function acquireOtpCooldown(
  cooldownKey: string,
  seconds = 60,
): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.set(cooldownKey, "1", "EX", seconds, "NX");
  return res === "OK";
}
