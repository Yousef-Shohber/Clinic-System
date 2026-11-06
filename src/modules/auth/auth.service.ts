import { IUser, User } from "../../models/user.model";
import { AppError } from "../../types/errors";
import { REDIS_KEYS } from "../../services/cache.service";
import {
  acquireOtpCooldown,
  createOTP,
  verifyOTP,
} from "../../services/otp.service";
import { emailService } from "../../services/email.service";
import { uploadImage, deleteImage } from "../../services/cloudinary.service";
import { JwtPayload } from "../../types/express";
import getEnv from "../../config/env";
import getRedis from "../../config/redis";
import bcrypt from "bcryptjs";
import { Doctor } from "../../models/doctor.model";
import { cacheService } from "../../services/cache.service";
import { logger } from "../../config/logger";
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeAllUserTokens,
  revokeRefreshToken,
} from "./token.service";
import { RegisterDtoType, LoginDtoType } from "./auth.schema";

// ===== Register =====

export async function register(dto: RegisterDtoType) {
  const existing = await User.findOne({ email: dto.email });
  if (existing) {
    throw new AppError("EMAIL_TAKEN", 409, "Email already in use");
  }

  const user = await User.create({
    name: dto.name,
    email: dto.email,
    password: dto.password,
    role: dto.role,
  });

  try {
    const otp = await createOTP(REDIS_KEYS.otpEmailVerify(user.email));

    await emailService.send(user.email, "email_verification_otp", {
      otp,
      expiresInMinutes: getEnv().OTP_EXPIRES_MINUTES,
    });
  } catch (err) {
    // Partial failure: the account exists but the user never got a code.
    // Roll back so a retry doesn't hit EMAIL_TAKEN.
    await User.deleteOne({ _id: user._id });
    await getRedis().del(REDIS_KEYS.otpEmailVerify(user.email));
    throw err;
  }

  return { user, message: "Verification OTP sent to email" };
}

// ===== Verify Email =====

export async function verifyEmail(email: string, otp: string) {
  await verifyOTP(REDIS_KEYS.otpEmailVerify(email), otp);

  const user = await User.findOneAndUpdate(
    { email },
    { isEmailVerified: true },
    { new: true },
  );

  if (!user) {
    throw new AppError("NOT_FOUND", 404, "User not found");
  }

  const accessToken = generateAccessToken({ userId: user.id, role: user.role });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      profilePhoto: user.profilePhoto,
    },
    tokens: { accessToken, refreshToken },
  };
}

// ===== Resend OTP =====

export async function resendOtp(email: string) {
  // The cooldown is keyed by email only, so it behaves identically whether or
  // not the account exists (no enumeration through this endpoint).
  const allowed = await acquireOtpCooldown(
    REDIS_KEYS.otpCooldown("verify", email),
  );
  if (!allowed) {
    throw new AppError(
      "OTP_COOLDOWN",
      429,
      "Please wait a minute before requesting another OTP",
    );
  }

  const user = await User.findOne({ email });
  if (user && !user.isEmailVerified) {
    const otp = await createOTP(REDIS_KEYS.otpEmailVerify(email));
    await emailService.send(email, "email_verification_otp", {
      otp,
      expiresInMinutes: getEnv().OTP_EXPIRES_MINUTES,
    });
  }

  return {
    message: "If the account exists and is unverified, an OTP was sent",
  };
}

// ===== Login =====

const MAX_LOGIN_FAILURES = 10;
const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;
let _dummyHash: string | undefined;

async function recordLoginFailure(email: string): Promise<void> {
  const redis = getRedis();
  const key = REDIS_KEYS.loginFailures(email);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
}

export async function login(dto: LoginDtoType) {
  const redis = getRedis();
  const failKey = REDIS_KEYS.loginFailures(dto.email);

  // Per-account throttle (the IP limiter alone doesn't stop distributed guessing)
  const failures = Number((await redis.get(failKey)) ?? 0);
  if (failures >= MAX_LOGIN_FAILURES) {
    throw new AppError(
      "TOO_MANY_ATTEMPTS",
      429,
      "Too many failed login attempts. Try again later",
    );
  }

  const user = await User.findOne({ email: dto.email }).select("+password");

  if (!user) {
    // Burn the same bcrypt time as a real check so response time doesn't
    // reveal whether the email exists
    _dummyHash ??= await bcrypt.hash("dummy-password", getEnv().BCRYPT_ROUNDS);
    await bcrypt.compare(dto.password, _dummyHash);
    await recordLoginFailure(dto.email);
    throw new AppError("UNAUTHORIZED", 401, "Invalid credentials");
  }

  const isValid = await user.comparePassword(dto.password);
  if (!isValid) {
    await recordLoginFailure(dto.email);
    throw new AppError("UNAUTHORIZED", 401, "Invalid credentials");
  }

  // Checked only after the password is proven, so it can't be used to probe
  // which emails are registered-but-unverified
  if (!user.isEmailVerified) {
    throw new AppError(
      "EMAIL_NOT_VERIFIED",
      403,
      "Please verify your email first",
    );
  }

  await redis.del(failKey);

  const accessToken = generateAccessToken({ userId: user.id, role: user.role });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      profilePhoto: user.profilePhoto,
    },
    tokens: { accessToken, refreshToken },
  };
}

// ===== Forget Password =====

export async function forgetPassword(email: string) {
  const allowed = await acquireOtpCooldown(
    REDIS_KEYS.otpCooldown("reset", email),
  );
  if (!allowed) return; // silent: never reveals anything about the account

  const user = await User.findOne({ email });
  if (!user) return;

  const otp = await createOTP(REDIS_KEYS.otpPasswordReset(email));
  await emailService.send(email, "password_reset_otp", {
    otp,
    expiresInMinutes: getEnv().OTP_EXPIRES_MINUTES,
  });
}

// ===== Reset Password =====

export async function resetPassword(
  email: string,
  otp: string,
  newPassword: string,
) {
  await verifyOTP(REDIS_KEYS.otpPasswordReset(email), otp);

  const user = await User.findOne({ email });
  if (!user) throw new AppError("NOT_FOUND", 404, "User not found");

  user.password = newPassword;
  await user.save();

  await revokeAllUserTokens(user.id);

  return { message: "Password reset successful, Please Login" };
}

// ===== Refresh Tokens =====

export async function refreshTokens(refreshToken: string) {
  return rotateRefreshToken(refreshToken);
}

// ===== Logout =====

export async function logout(refreshToken: string) {
  await revokeRefreshToken(refreshToken);
}

// ===== Change Profile Image =====

export async function changeProfileImage(userId: string, fileBuffer: Buffer) {
  const user = await User.findById(userId);
  if (!user) throw new AppError("NOT_FOUND", 404, "User not found");

  const oldPublicId = user.profilePhoto.publicId;

  const result = await uploadImage(fileBuffer, "clinic/profiles");
  user.profilePhoto = { url: result.secure_url, publicId: result.public_id };
  try {
    await user.save();
  } catch (err) {
    // DB write failed: don't leave an orphan upload behind
    await deleteImage(result.public_id).catch(() => undefined);
    throw err;
  }

  // Only now is it safe to drop the previous image; a failure here just
  // leaves an orphan file and must not fail the request.
  if (oldPublicId) {
    await deleteImage(oldPublicId).catch((err) =>
      logger.warn({ err, oldPublicId }, "Failed to delete old profile image"),
    );
  }

  return { profilePhoto: user.profilePhoto };
}

// ===== Delete User (Admin) =====

export async function deleteUser(targetUserId: string) {
  const user = await User.findById(targetUserId);
  if (!user) throw new AppError("NOT_FOUND", 404, "User not found");

  if (user.profilePhoto.publicId) {
    await deleteImage(user.profilePhoto.publicId);
  }

  await revokeAllUserTokens(targetUserId);

  // A deleted account must not keep a public, bookable doctor profile
  const doctor = await Doctor.findOneAndUpdate(
    { userId: user._id },
    { isActive: false },
  );
  if (doctor) {
    await cacheService.del(REDIS_KEYS.doctorProfile(doctor._id.toString()));
    await cacheService.invalidateDoctorSlots(doctor._id.toString());
  }

  await user.deleteOne();

  return { message: "User deleted successfully" };
}

// ===== Change Password =====

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await User.findById(userId).select("+password");
  if (!user) throw new AppError("NOT_FOUND", 404, "User not found");

  if (!user.password) {
    throw new AppError(
      "NO_PASSWORD",
      400,
      "This account uses Google sign-in. Use forget password to set a password.",
    );
  }

  const isValid = await user.comparePassword(currentPassword);
  if (!isValid) {
    throw new AppError(
      "INVALID_PASSWORD",
      400,
      "Current password is incorrect",
    );
  }

  if (currentPassword === newPassword) {
    throw new AppError(
      "SAME_PASSWORD",
      400,
      "New password must be different from current password",
    );
  }

  user.password = newPassword;
  await user.save();

  await revokeAllUserTokens(userId);

  return { message: "Password changed successfully. Please login again." };
}

// ===== Google OAuth =====

export async function googleLogin(user: IUser) {
  const accessToken = generateAccessToken({
    userId: user._id.toString(),
    role: user.role,
  });
  const refreshToken = await generateRefreshToken(user._id.toString());

  return {
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      profilePhoto: user.profilePhoto,
    },
    tokens: { accessToken, refreshToken },
  };
}
