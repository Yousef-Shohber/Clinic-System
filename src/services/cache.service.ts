import getRedis from "../config/redis";
import getEnv from "../config/env";

export const REDIS_KEYS = {
  slotLock: (doctorId: string, date: string, startTime: string) =>
    `lock:slot:${doctorId}:${date}:${startTime}`,

  doctorSlotsVersion: (doctorId: string) => `doctor:slots:ver:${doctorId}`,

  doctorSlots: (doctorId: string, date: string, version: string = "0") =>
    `doctor:slots:${doctorId}:v${version}:${date}`,

  doctorProfile: (doctorId: string) => `doctor:profile:${doctorId}`,

  refreshToken: (userId: string, jti: string) => `rt:${userId}:${jti}`,

  allRefreshTokens: (userId: string) => `rt:${userId}:*`,

  otpEmailVerify: (email: string) => `otp:email-verify:${email.toLowerCase()}`,

  otpPasswordReset: (email: string) =>
    `otp:password-reset:${email.toLowerCase()}`,

  otpCooldown: (purpose: string, email: string) =>
    `otp:cooldown:${purpose}:${email.toLowerCase()}`,

  loginFailures: (email: string) => `login:fail:${email.toLowerCase()}`,

  rateLimit: (identifier: string, path: string) => `rl:${identifier}:${path}`,

  idempotency: (userId: string, key: string) => `idem:${userId}:${key}`,
};

export class CacheService {
  private redis = getRedis();

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.redis.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const env = getEnv();
    const ttl = ttlSeconds ?? env.CACHE_TTL_SECONDS;
    await this.redis.set(key, JSON.stringify(value), "EX", ttl);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys);
  }

  async getDoctorSlotsVersion(doctorId: string): Promise<string> {
    try {
      return (
        (await this.redis.get(REDIS_KEYS.doctorSlotsVersion(doctorId))) ?? "0"
      );
    } catch {
      return "0";
    }
  }

  async invalidateDoctorSlots(doctorId: string): Promise<void> {
    const key = REDIS_KEYS.doctorSlotsVersion(doctorId);
    await this.redis.incr(key);
    await this.redis.expire(key, 86400);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    let cursor = "0";
    const keysToDelete: string[] = [];

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      keysToDelete.push(...keys);
    } while (cursor !== "0");

    if (keysToDelete.length > 0) await this.redis.del(...keysToDelete);
  }
}

export const cacheService = new CacheService();
