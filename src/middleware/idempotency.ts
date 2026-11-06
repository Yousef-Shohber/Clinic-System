import { RequestHandler } from "express";
import crypto from "crypto";
import getRedis from "../config/redis";
import getEnv from "../config/env";
import { AppError } from "../types/errors";
import { REDIS_KEYS } from "../services/cache.service";

const MAX_KEY_LENGTH = 128;
const PROCESSING_TTL_SECONDS = 60;

interface StoredRecord {
  state: "processing" | "done";
  fingerprint: string;
  response?: unknown;
}

function fingerprint(req: Parameters<RequestHandler>[0]): string {
  return crypto
    .createHash("sha256")
    .update(
      `${req.method}:${req.baseUrl}${req.path}:${JSON.stringify(req.body ?? {})}`,
    )
    .digest("hex");
}

export function idempotency(): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      const idempotencyKey = req.headers["idempotency-key"] as
        | string
        | undefined;
      if (!idempotencyKey) return next();

      if (idempotencyKey.length > MAX_KEY_LENGTH) {
        return next(
          new AppError(
            "INVALID_IDEMPOTENCY_KEY",
            400,
            "Idempotency-Key too long",
          ),
        );
      }

      const redis = getRedis();
      const cacheKey = REDIS_KEYS.idempotency(req.user.userId, idempotencyKey);
      const fp = fingerprint(req);

      const claimed = await redis.set(
        cacheKey,
        JSON.stringify({
          state: "processing",
          fingerprint: fp,
        } as StoredRecord),
        "EX",
        PROCESSING_TTL_SECONDS,
        "NX",
      );

      if (claimed !== "OK") {
        const raw = await redis.get(cacheKey);
        const existing = raw ? (JSON.parse(raw) as StoredRecord) : null;

        if (!existing) {
          return next(
            new AppError("IDEMPOTENCY_RETRY", 409, "Please retry the request"),
          );
        }

        if (existing.fingerprint && existing.fingerprint !== fp) {
          return next(
            new AppError(
              "IDEMPOTENCY_KEY_REUSED",
              422,
              "Idempotency-Key was already used with a different request",
            ),
          );
        }

        if (existing.state === "processing") {
          return next(
            new AppError(
              "REQUEST_IN_PROGRESS",
              409,
              "A request with this Idempotency-Key is still being processed",
            ),
          );
        }
        res.set("X-Idempotent-Replay", "true").json(existing.response);
        return;
      }

      res.locals.idempotencyKey = cacheKey;
      res.locals.idempotencyFingerprint = fp;

      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return;
        redis.del(cacheKey).catch(() => undefined);
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function storeIdempotentResponse(
  cacheKey: string,
  data: unknown,
  fp?: string,
): Promise<void> {
  const redis = getRedis();
  const env = getEnv();

  const record: StoredRecord = {
    state: "done",
    fingerprint: fp ?? "",
    response: data,
  };
  await redis.set(
    cacheKey,
    JSON.stringify(record),
    "EX",
    env.IDEMPOTENCY_TTL_SECONDS,
  );
}
