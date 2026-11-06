import { RequestHandler } from "express";
import { randomUUID } from "crypto";
import getRedis from "../config/redis";
import { AppError } from "../types/errors";
import { RATE_LIMIT_SCRIPT } from "../utils/lua-scripts";
import { REDIS_KEYS } from "../services/cache.service";

interface RateLimiterOptions {
  max: number;
  windowMs: number;
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      const redis = getRedis();

      const userId = (req.user as { userId?: string } | undefined)?.userId;
      const identifier = userId ?? req.ip ?? "unknown";
      const key = REDIS_KEYS.rateLimit(identifier, req.path);

      const now = Date.now().toString();
      const windowStart = (Date.now() - options.windowMs).toString();
      const ttl = Math.ceil(options.windowMs / 1000).toString();

      const count = (await redis.eval(
        RATE_LIMIT_SCRIPT,
        1,
        key,
        now,
        windowStart,
        ttl,
        randomUUID(),
      )) as number;

      res.set("X-RateLimit-Limit", options.max.toString());
      res.set(
        "X-RateLimit-Remaining",
        Math.max(0, options.max - count).toString(),
      );

      if (count > options.max) {
        res.set("Retry-After", ttl);
        return next(
          new AppError("RATE_LIMIT_EXCEEDED", 429, "Too many requests"),
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
