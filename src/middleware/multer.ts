import multer, { FileFilterCallback } from "multer";
import { Request, RequestHandler } from "express";
import { AppError } from "../types/errors";

const storage = multer.memoryStorage();

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new AppError("INVALID_FILE_TYPE", 422, "Only images are allowed"));
  }
}

const multerInstance = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

export function uploadImage(fieldName = "image"): RequestHandler {
  return (req, res, next) => {
    multerInstance.array(fieldName)(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          return next(new AppError("UPLOAD_ERROR", 422, err.message));
        }

        if (err instanceof Error) return next(err);

        return next(new AppError("UPLOAD_FAILED", 500, "Upload failed"));
      }

      const files = (req.files ?? []) as Express.Multer.File[];

      if (files.length > 1) {
        return next(
          new AppError("MULTIPLE_FILES", 422, "Only one image is allowed"),
        );
      } else if (files.length === 1) {
        req.file = files[0];
      }

      next();
    });
  };
}
