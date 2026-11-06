import nodemailer, { Transporter } from "nodemailer";
import getEnv from "../config/env";
import { logger } from "../config/logger";

let _transporter: Transporter;

function getTransporter(): Transporter {
  if (_transporter) return _transporter;
  const env = getEnv();

  _transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return _transporter;
}

// doctorName is user-controlled: never interpolate it into HTML unescaped
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type TemplateKey =
  | "email_verification_otp"
  | "password_reset_otp"
  | "appointment_confirmed"
  | "appointment_cancelled"
  | "appointment_expired"
  | "appointment_completed"
  | "appointment_reminder";

type TemplateData = {
  email_verification_otp: {
    otp: string;
    expiresInMinutes: number;
  };
  password_reset_otp: {
    otp: string;
    expiresInMinutes: number;
  };
  appointment_confirmed: {
    doctorName: string;
    date: string;
    startTime: string;
  };
  appointment_cancelled: {
    doctorName: string;
    date: string;
    startTime: string;
  };
  appointment_expired: {
    doctorName: string;
    date: string;
    startTime: string;
  };
  appointment_completed: {
    doctorName: string;
    date: string;
  };
  appointment_reminder: {
    doctorName: string;
    date: string;
    startTime: string;
  };
};

type Template = { subject: string; html: string };

function buildTemplate<K extends TemplateKey>(
  key: K,
  data: TemplateData[K],
): Template {
  switch (key) {
    case "email_verification_otp": {
      const d = data as TemplateData["email_verification_otp"];
      return {
        subject: "Verify your email",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>Email Verification</h2>
            <p>Your verification code is:</p>
            <h1 style="letter-spacing:8px;color:#4F46E5">${d.otp}</h1>
            <p>Expires in <strong>${d.expiresInMinutes} minutes</strong>.</p>
            <p>If you didn't request this, ignore this email.</p>
          </div>`,
      };
    }

    case "password_reset_otp": {
      const d = data as TemplateData["password_reset_otp"];
      return {
        subject: "Reset your password",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>Password Reset</h2>
            <p>Your reset code is:</p>
            <h1 style="letter-spacing:8px;color:#4F46E5">${d.otp}</h1>
            <p>Expires in <strong>${d.expiresInMinutes} minutes</strong>.</p>
            <p>If you didn't request this, ignore this email.</p>
          </div>`,
      };
    }

    case "appointment_confirmed": {
      const d = data as TemplateData["appointment_confirmed"];
      return {
        subject: "Appointment Confirmed",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>Your appointment is confirmed</h2>
            <p><strong>Doctor:</strong> ${esc(d.doctorName)}</p>
            <p><strong>Date:</strong> ${esc(d.date)}</p>
            <p><strong>Time:</strong> ${esc(d.startTime)}</p>
          </div>`,
      };
    }

    case "appointment_cancelled": {
      const d = data as TemplateData["appointment_cancelled"];
      return {
        subject: "Appointment Cancelled",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>Your appointment has been cancelled</h2>
            <p><strong>Doctor:</strong> ${esc(d.doctorName)}</p>
            <p><strong>Date:</strong> ${esc(d.date)}</p>
            <p><strong>Time:</strong> ${esc(d.startTime)}</p>
            <p>If you paid, a full refund will be processed shortly.</p>
          </div>`,
      };
    }

    case "appointment_expired": {
      const d = data as TemplateData["appointment_expired"];
      return {
        subject: "Appointment Expired",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>Your appointment has expired</h2>
            <p><strong>Doctor:</strong> ${esc(d.doctorName)}</p>
            <p><strong>Date:</strong> ${esc(d.date)}</p>
            <p><strong>Time:</strong> ${esc(d.startTime)}</p>
            <p>Payment was not completed in time. Please book again.</p>
          </div>`,
      };
    }

    case "appointment_completed": {
      const d = data as TemplateData["appointment_completed"];
      return {
        subject: "Appointment Completed 🎉",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>Appointment completed</h2>
            <p><strong>Doctor:</strong> ${esc(d.doctorName)}</p>
            <p><strong>Date:</strong> ${esc(d.date)}</p>
            <p>We hope you had a great experience. Please leave a review!</p>
          </div>`,
      };
    }

    case "appointment_reminder": {
      const d = data as TemplateData["appointment_reminder"];
      return {
        subject: "Reminder: Appointment Tomorrow",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2>You have an appointment tomorrow</h2>
            <p><strong>Doctor:</strong> ${esc(d.doctorName)}</p>
            <p><strong>Date:</strong> ${esc(d.date)}</p>
            <p><strong>Time:</strong> ${esc(d.startTime)}</p>
          </div>`,
      };
    }

    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown email template: ${_exhaustive}`);
    }
  }
}

class EmailService {
  async send<K extends TemplateKey>(
    to: string,
    template: K,
    data: TemplateData[K],
  ): Promise<void> {
    const env = getEnv();
    const transporter = getTransporter();
    const { subject, html } = buildTemplate(template, data);

    await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, html });
    logger.info({ to, template }, "Email sent");
  }
}

export const emailService = new EmailService();
