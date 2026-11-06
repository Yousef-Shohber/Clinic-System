import jwt from "jsonwebtoken";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import getRedis from "../../config/redis";
import getEnv from "../../config/env";
import { AppError } from "../../types/errors";
import { Role } from "../../types/enums";
import { REDIS_KEYS } from "../../services/cache.service";
import { User } from "../../models/user.model";

interface AccessTokenPayload {
  userId: string;
  role: Role;
}

export function parseDurationToSeconds(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    default:
      return value;
  }
}

// Atomic "read and delete": two concurrent refreshes with the same token can
// never both consume it.
const CONSUME_SCRIPT = `
local v = redis.call("GET", KEYS[1])
if v then redis.call("DEL", KEYS[1]) end
return v
`;

async function scanKeys(pattern: string): Promise<string[]> {
  const redis = getRedis();
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [nextCursor, found] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== "0");
  return keys;
}

export function generateAccessToken(payload: AccessTokenPayload): string {
  const env = getEnv();
  const jti = uuidv4();
  return jwt.sign(
    { userId: payload.userId, role: payload.role, jti },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"] },
  );
}

export async function generateRefreshToken(userId: string): Promise<string> {
  const env = getEnv();
  const redis = getRedis();
  const jti = uuidv4();

  const token = jwt.sign({ userId, jti }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });

  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const ttl = parseDurationToSeconds(env.JWT_REFRESH_EXPIRES_IN);
  await redis.setex(REDIS_KEYS.refreshToken(userId, jti), ttl, hash);

  return token;
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  const keys = await scanKeys(REDIS_KEYS.allRefreshTokens(userId));
  if (keys.length > 0) {
    const redis = getRedis();
    await redis.del(...keys);
  }
}

/** Revoke the single session a refresh token belongs to (logout). */
export async function revokeRefreshToken(token: string): Promise<void> {
  const env = getEnv();
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      ignoreExpiration: true,
    }) as { userId: string; jti: string };
    await getRedis().del(REDIS_KEYS.refreshToken(decoded.userId, decoded.jti));
  } catch {
    // Invalid/forged token: nothing to revoke
  }
}

export async function rotateRefreshToken(
  oldToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const env = getEnv();
  const redis = getRedis();

  let decoded: { userId: string; jti: string };
  try {
    decoded = jwt.verify(oldToken, env.JWT_REFRESH_SECRET) as {
      userId: string;
      jti: string;
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError("TOKEN_EXPIRED", 401, "Refresh token expired");
    }
    throw new AppError("INVALID_TOKEN", 401, "Invalid refresh token");
  }

  const { userId, jti } = decoded;
  const storedHash = (await redis.eval(
    CONSUME_SCRIPT,
    1,
    REDIS_KEYS.refreshToken(userId, jti),
  )) as string | null;

  if (!storedHash) {
    await revokeAllUserTokens(userId);
    throw new AppError(
      "REFRESH_TOKEN_REUSE",
      401,
      "Refresh token reuse detected",
    );
  }

  const incomingHash = crypto
    .createHash("sha256")
    .update(oldToken)
    .digest("hex");
  if (incomingHash !== storedHash) {
    await revokeAllUserTokens(userId);
    throw new AppError(
      "REFRESH_TOKEN_REUSE",
      401,
      "Refresh token reuse detected",
    );
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError("USER_NOT_FOUND", 404, "User not found");
  }

  const accessToken = generateAccessToken({ userId, role: user.role });
  const refreshToken = await generateRefreshToken(userId);

  return { accessToken, refreshToken };
}
