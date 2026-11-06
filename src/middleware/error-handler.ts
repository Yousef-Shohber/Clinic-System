import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AppError } from "../types/errors";
import { logger } from "../config/logger";
import getEnv from "../config/env";

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface HttpClientError {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isHttpClientError(err: unknown): err is HttpClientError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as HttpClientError;
  const status = e.status ?? e.statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const env = getEnv();

  logger.error(
    { err, requestId: req.requestId, path: req.path },
    "Request error",
  );

  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "An unexpected error occurred";
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 422;
    code = "VALIDATION_ERROR";
    message = "Validation failed";
    details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = 400;
    code = "INVALID_ID";
    message = `Invalid value for field: ${err.path}`;
  } else if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code as number) === 11000
  ) {
    const mongoErr = err as { keyValue?: Record<string, unknown> };
    statusCode = 409;
    code = "DUPLICATE_KEY";
    const field = mongoErr.keyValue
      ? Object.keys(mongoErr.keyValue)[0]
      : "unknown";
    message = `Duplicate value for field: ${field}`;
  } else if (isHttpClientError(err)) {
    statusCode = err.status ?? err.statusCode ?? 400;
    switch (err.type) {
      case "entity.too.large":
        code = "PAYLOAD_TOO_LARGE";
        message = "Request body too large";
        break;
      case "entity.parse.failed":
        code = "INVALID_JSON";
        message = "Malformed JSON body";
        break;
      default:
        code = "BAD_REQUEST";
        message = "Bad request";
    }
  } else if (err instanceof Error) {
    if (env.NODE_ENV !== "production") {
      message = err.message;
    }
  }

  const body: ErrorResponse = {
    success: false,
    error: { code, message },
  };

  if (details !== undefined) {
    body.error.details = details;
  }

  res.status(statusCode).json(body);
}
