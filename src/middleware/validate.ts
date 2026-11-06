import { RequestHandler } from "express";
import { ZodSchema } from "zod";
import { AppError } from "../types/errors";

export function validate(
  schema: ZodSchema,
  target: "body" | "query" | "params" = "body",
): RequestHandler {
  return (req, _res, next): void => {
    const input = req[target] ?? (target === "body" ? {} : req[target]);
    const result = schema.safeParse(input);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return next(
        new AppError("VALIDATION_ERROR", 422, "Validation failed", details),
      );
    }

    Object.defineProperty(req, target, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}
