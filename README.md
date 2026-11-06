# 🏥 Clinic Appointment Booking System — Backend

> Production-ready REST API for clinic appointment booking built with Node.js, TypeScript, Express.js, MongoDB, and Redis.

---

## 📋 Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Features](#features)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Authentication Flow](#authentication-flow)
- [Booking Flow](#booking-flow)
- [Payment Flow (Paymob)](#payment-flow-paymob)
- [WebSocket Events](#websocket-events)
- [Project Structure](#project-structure)
- [Background Workers](#background-workers)
- [Security](#security)
- [Error Handling](#error-handling)

---

## Overview

A full-featured clinic appointment booking backend that supports:

- **3 roles**: Patient, Doctor, Admin
- **Atomic slot booking** via Redis distributed locks (prevents double-booking)
- **Automated appointment expiration** via BullMQ delayed jobs
- **Real-time notifications** via Socket.io
- **Egyptian payment gateway** via Paymob (accepts Visa, Mastercard, Meeza, e-wallets)
- **Google OAuth** + Email/Password authentication with OTP verification

---

## Tech Stack

| Layer           | Technology                                                               |
| --------------- | ------------------------------------------------------------------------ |
| Runtime         | Node.js 20+ with TypeScript 5                                            |
| Framework       | Express.js                                                               |
| Database        | MongoDB with Mongoose                                                    |
| Cache / Locks   | Redis (ioredis) with Lua scripts                                         |
| Background Jobs | BullMQ                                                                   |
| Real-time       | Socket.io with Redis adapter                                             |
| Auth            | JWT (access + refresh rotation) + Google OAuth (Passport.js) + Email OTP |
| Payment         | Paymob (EGP)                                                             |
| File Upload     | Multer (memoryStorage) + Cloudinary                                      |
| Email           | Nodemailer (SMTP)                                                        |
| Validation      | Zod                                                                      |
| Logging         | Pino + pino-http                                                         |
| Security        | Helmet, CORS, Rate Limiting (sliding window Lua), Idempotency Keys       |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Client                           │
│              (Web / Mobile / Frontend)                  │
└──────────┬─────────────────────────┬────────────────────┘
           │ HTTP REST               │ WebSocket (Socket.io)
           ▼                         ▼
┌─────────────────────────────────────────────────────────┐
│                    Express.js API                       │
│                                                         │
│  Helmet │ CORS │ Rate Limit │ Auth │ Validate │ Log     │
├──────────┬───────────────┬───────────┬──────────────────│
│  Routes  │  Controllers  │  Services │  Middleware      │
└──────────┴───────┬───────┴───────────┴──────────────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
  ┌─────────┐ ┌────────┐ ┌──────────┐
  │ MongoDB │ │ Redis  │ │ BullMQ   │
  │ (data)  │ │(cache/ │ │(workers) │
  │         │ │ locks) │ │          │
  └─────────┘ └────────┘ └──────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
            ┌─────────────┐    ┌────────────────┐
            │ Expiration  │    │ Notification   │
            │   Worker    │    │    Worker      │
            └─────────────┘    └────────────────┘
```

---

## Features

### Authentication

- ✅ Register with email + OTP verification
- ✅ Login with JWT (access token 15m + refresh token 7d)
- ✅ Refresh token rotation with reuse detection
- ✅ Google OAuth 2.0
- ✅ Forget/Reset password with OTP
- ✅ Profile photo upload to Cloudinary
- ✅ Revoke all sessions on password change

### Doctors

- ✅ Create and manage doctor profile
- ✅ Search by name or specialization (MongoDB text index)
- ✅ Filter by rating, fees
- ✅ Admin verification before accepting appointments
- ✅ Weekly schedule management (per day, slot duration)
- ✅ Available slots calculation with Redis caching

### Appointments

- ✅ Atomic booking via Redis distributed lock
- ✅ Idempotency key support (prevents duplicate on network retry)
- ✅ Auto-expiration after 15 minutes if not paid (BullMQ)
- ✅ Status flow: `pending → confirmed → completed / cancelled / expired`
- ✅ Doctor notes (hidden from patients)
- ✅ Cancellation rules per role

### Payments (Paymob)

- ✅ Creates payment session → returns iframe URL
- ✅ Webhook with HMAC-SHA512 signature verification
- ✅ Auto-confirm appointment on payment success
- ✅ Full refund on cancellation or expiration
- ✅ Supports Visa, Mastercard, Meeza, e-wallets

### Reviews

- ✅ One review per completed appointment
- ✅ Auto-recalculates doctor's average rating
- ✅ Patient can edit/delete own reviews

### Real-time

- ✅ Socket.io with Redis adapter (horizontally scalable)
- ✅ JWT auth on WebSocket connection
- ✅ Events for all appointment status changes
- ✅ 24h appointment reminder

### Admin

- ✅ System statistics (users, revenue by month, top doctors)
- ✅ Manage all users and appointments
- ✅ Verify/unverify doctors

---

## Getting Started

### Prerequisites

- Node.js 20+
- MongoDB
- Redis

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd clinic-booking

# Install dependencies
npm install

# Copy environment file and fill in values
cp .env.example .env

# Start development server
npm run dev
```

### Scripts

```bash
npm run dev      # Start with nodemon (hot reload)
npm run build    # Compile TypeScript to dist/
npm run start    # Run compiled dist/server.js
npm run lint     # Type-check without emitting
```

---

## Environment Variables

Create a `.env` file in the root:

```env
# ─── App ────────────────────────────────────────────────
NODE_ENV=development
PORT=8000
CLIENT_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000

# ─── Database ───────────────────────────────────────────
MONGODB_URI=mongodb://localhost:27017/clinic-booking
REDIS_URL=redis://localhost:6379

# ─── Rate Limiting ──────────────────────────────────────
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100

# ─── JWT ────────────────────────────────────────────────
JWT_ACCESS_SECRET=your_access_secret_min_32_chars
JWT_REFRESH_SECRET=your_refresh_secret_min_32_chars
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
COOKIE_SECRET=your_cookie_secret_min_32_chars

# ─── Email (SMTP) ───────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
EMAIL_FROM=Clinic Booking <your_email@gmail.com>

# ─── Google OAuth ───────────────────────────────────────
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=http://localhost:8000/api/v1/auth/google/callback

# ─── Cloudinary ─────────────────────────────────────────
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ─── Paymob ─────────────────────────────────────────────
PAYMOB_API_KEY=your_paymob_api_key
PAYMOB_INTEGRATION_ID=your_integration_id
PAYMOB_IFRAME_ID=your_iframe_id
PAYMOB_HMAC_SECRET=your_hmac_secret

# ─── Config ─────────────────────────────────────────────
BCRYPT_ROUNDS=12
OTP_LENGTH=6
OTP_EXPIRES_MINUTES=10
APPOINTMENT_EXPIRY_MINUTES=15
CACHE_TTL_SECONDS=60
LOCK_TTL_MS=10000
IDEMPOTENCY_TTL_SECONDS=86400

# Timezone the clinic schedules ("09:00" slots) are expressed in (IANA name)
CLINIC_TIMEZONE=Africa/Cairo

# Optional: override the Paymob API base (tests point it at a local stand-in)
# PAYMOB_BASE_URL=https://accept.paymob.com/api
```

> **Getting Paymob keys:**
>
> 1. Register at [paymob.com](https://paymob.com)
> 2. Go to **Accept → Integrations → Online Card Payment**
> 3. Copy your **API Key**, **Integration ID**, **HMAC Secret**
> 4. Create an iframe: **Accept → Iframes** → copy the **Iframe ID**

---

## API Reference

> Full interactive documentation available in [`API_DOCS.html`](./API_DOCS.html) — open in browser.

### Base URL

```
http://localhost:8000/api/v1
```

### Endpoints Summary

| Method           | Endpoint                                  | Auth          | Description                  |
| ---------------- | ----------------------------------------- | ------------- | ---------------------------- |
| GET              | `/health`                                 | Public        | Server health check          |
| **Auth**         |                                           |               |                              |
| POST             | `/auth/register`                          | Public        | Register (sends OTP)         |
| POST             | `/auth/verify-email`                      | Public        | Verify OTP → get token       |
| POST             | `/auth/resend-otp`                        | Public        | Resend OTP                   |
| POST             | `/auth/login`                             | Public        | Login                        |
| GET              | `/auth/google`                            | Public        | Google OAuth redirect        |
| POST             | `/auth/forget-password`                   | Public        | Send reset OTP               |
| POST             | `/auth/reset-password`                    | Public        | Reset with OTP               |
| GET              | `/auth/refresh`                           | Cookie        | Rotate refresh token         |
| GET              | `/auth/logout`                            | Auth          | Revoke session               |
| PATCH            | `/auth/change-profile-image`              | Auth          | Upload profile photo         |
| DELETE           | `/auth/:id`                               | Admin         | Delete user                  |
| **Doctors**      |                                           |               |                              |
| POST             | `/doctors`                                | Doctor        | Create profile               |
| GET              | `/doctors`                                | Public        | List doctors (search/filter) |
| GET              | `/doctors/:id`                            | Public        | Doctor profile + reviews     |
| PATCH            | `/doctors/:id`                            | Doctor        | Update own profile           |
| PATCH            | `/doctors/:id/verify`                     | Admin         | Verify/unverify              |
| GET              | `/doctors/:id/slots?date=`                | Auth          | Available slots              |
| **Schedules**    |                                           |               |                              |
| POST             | `/schedules`                              | Doctor        | Create schedule              |
| GET              | `/schedules`                              | Doctor        | My schedules                 |
| PATCH            | `/schedules/:id`                          | Doctor        | Update schedule              |
| DELETE           | `/schedules/:id`                          | Doctor        | Delete schedule              |
| **Appointments** |                                           |               |                              |
| POST             | `/appointments`                           | Patient       | Book appointment             |
| GET              | `/appointments/me`                        | Auth          | My appointments              |
| GET              | `/appointments`                           | Admin         | All appointments             |
| GET              | `/appointments/:id`                       | Auth          | Single appointment           |
| PATCH            | `/appointments/:id/cancel`                | Auth          | Cancel                       |
| PATCH            | `/appointments/:id/complete`              | Doctor        | Mark completed               |
| **Payments**     |                                           |               |                              |
| POST             | `/payments/create-session/:appointmentId` | Patient       | Create Paymob session        |
| POST             | `/payments/webhook`                       | Paymob        | Payment webhook              |
| POST             | `/payments/refund/:appointmentId`         | Admin         | Manual refund                |
| **Reviews**      |                                           |               |                              |
| POST             | `/reviews`                                | Patient       | Leave review                 |
| GET              | `/reviews/doctor/:doctorId`               | Public        | Doctor reviews               |
| PATCH            | `/reviews/:id`                            | Patient       | Edit review                  |
| DELETE           | `/reviews/:id`                            | Patient/Admin | Delete review                |
| **Admin**        |                                           |               |                              |
| GET              | `/admin/stats`                            | Admin         | System statistics            |
| GET              | `/admin/users`                            | Admin         | All users                    |
| GET              | `/admin/doctors/pending`                  | Admin         | Unverified doctors           |

---

## Authentication Flow

### Register & Login

```
POST /auth/register  →  OTP sent to email
POST /auth/verify-email  →  { accessToken } + refreshToken cookie
```

### Token Strategy

```
accessToken  (15m)  →  returned in response body
                    →  store in memory only (never localStorage)
                    →  send as: Authorization: Bearer <token>

refreshToken (7d)   →  HttpOnly cookie (path: /api/v1/auth)
                    →  never accessible from JavaScript
                    →  auto-sent by browser on /api/v1/auth/* requests
```

### Token Rotation & Reuse Detection

```
GET /auth/refresh
  → reads refreshToken from cookie
  → verifies + checks Redis (jti must exist)
  → deletes old jti, issues new pair
  → sets new cookie

If old token used again (stolen token):
  → jti not in Redis → REVOKE ALL user sessions → force re-login
```

---

## Booking Flow

```
1. Patient calls POST /appointments
   ├─ Checks: doctor isVerified + isActive
   ├─ Checks: no duplicate appointment
   ├─ Gets schedule for that day → validates slot
   ├─ Acquires Redis distributed lock (prevents race condition)
   │    └─ Double-checks slot availability inside lock
   │    └─ Creates appointment { status: pending, expiresAt: +15min }
   ├─ Schedules BullMQ expiry job (fires at expiresAt)
   ├─ Invalidates doctor slots cache
   ├─ Emits WS: appointment:created
   └─ Releases lock

2. Patient calls POST /payments/create-session/:id
   └─ Returns { iframeUrl } → patient completes payment in iframe

3. Paymob calls POST /payments/webhook (on success)
   ├─ Verifies HMAC-SHA512 signature
   ├─ Updates: status → confirmed, paymentStatus → paid
   ├─ Removes BullMQ expiry job
   ├─ Emits WS: appointment:confirmed
   └─ Sends confirmation email + schedules 24h reminder

4. If payment not completed within 15 minutes:
   └─ BullMQ job fires:
        ├─ Updates: status → expired
        ├─ Refunds if somehow paid
        ├─ Emits WS: appointment:expired
        └─ Sends expiry email
```

---

## Payment Flow (Paymob)

```
POST /payments/create-session/:appointmentId
  ├─ Step 1: POST /api/auth/tokens → authToken
  ├─ Step 2: POST /ecommerce/orders → orderId
  ├─ Step 3: POST /acceptance/payment_keys → paymentToken
  └─ Returns: { iframeUrl, paymobOrderId }

Frontend:
  window.location.href = iframeUrl
  // or embed as <iframe src={iframeUrl} />

Paymob → POST /payments/webhook?hmac=...
  ├─ Verify HMAC-SHA512
  ├─ payment success → confirm appointment
  └─ refund → update paymentStatus
```

---

## WebSocket Events

**Connect:**

```javascript
const socket = io("http://localhost:8000", {
  auth: { token: accessToken }, // raw JWT, no "Bearer" prefix
});
```

**Events (Server → Client):**

```javascript
socket.on(
  "appointment:created",
  ({ appointmentId, doctorId, date, startTime }) => {},
);
socket.on("appointment:confirmed", ({ appointmentId }) => {});
socket.on("appointment:cancelled", ({ appointmentId }) => {});
socket.on("appointment:completed", ({ appointmentId }) => {});
socket.on("appointment:expired", ({ appointmentId }) => {});
socket.on("appointment:reminder", ({ appointmentId, date, startTime }) => {});
```

> All events are scoped to the authenticated user's room: `user:{userId}`

---

## Project Structure

```
src/
├── config/
│   ├── env.ts              # Zod-validated env (getEnv singleton)
│   ├── database.ts         # MongoDB with retry logic
│   ├── redis.ts            # ioredis singleton + helpers
│   ├── logger.ts           # Pino with redaction
│   ├── passport.ts         # Google OAuth strategy
│   └── cloudinary.ts       # Cloudinary SDK init
│
├── types/
│   ├── enums.ts            # Role, AppointmentStatus, PaymentStatus, Day, NotificationType
│   ├── errors.ts           # AppError class (code, statusCode, message, details)
│   └── express.d.ts        # req.user: JwtPayload, req.requestId
│
├── utils/
│   ├── async-handler.ts    # Express async wrapper → catches promise rejections
│   ├── lua-scripts.ts      # RELEASE_LOCK_SCRIPT, RATE_LIMIT_SCRIPT
│   └── schedule-generator.ts # generateSlots(), getDayName()
│
├── services/
│   ├── cache.service.ts    # CacheService class + REDIS_KEYS (centralized)
│   ├── lock.service.ts     # LockService class (acquire/release/withLock + retries)
│   ├── otp.service.ts      # createOTP/verifyOTP (SHA-256 hashed in Redis)
│   ├── email.service.ts    # EmailService with typed templates
│   ├── cloudinary.service.ts # uploadImage/deleteImage
│   └── websocket.service.ts  # initWebSocket, emitToUser, wsEmit typed emitters
│
├── middleware/
│   ├── authenticate.ts     # Bearer JWT → req.user (JwtPayload)
│   ├── authorize.ts        # Role-based access (supports multiple roles)
│   ├── validate.ts         # Zod schema factory (body/query/params)
│   ├── multer.ts           # uploadImage() — memoryStorage, 5MB limit
│   ├── rate-limit.ts       # createRateLimiter() factory (sliding window Lua)
│   ├── idempotency.ts      # Idempotency-Key header caching
│   └── error-handler.ts    # Global error handler (AppError, Mongoose, 11000)
│
├── models/
│   ├── user.model.ts       # bcrypt pre-save hook, comparePassword method
│   ├── doctor.model.ts     # text index (name + specialization)
│   ├── schedule.model.ts   # compound unique index {doctorId, day}
│   ├── appointment.model.ts # partial unique slot index (active statuses only), doctorNotes select:false
│   └── review.model.ts     # post-save/findOneAndDelete → recalculate doctor rating
│
├── modules/
│   ├── auth/
│   │   ├── auth.schema.ts      # RegisterDto, LoginDto, etc.
│   │   ├── token.service.ts    # JWT generate/rotate, Redis jti storage, reuse detection
│   │   ├── auth.service.ts     # Business logic
│   │   ├── auth.controller.ts  # Request handlers
│   │   └── auth.routes.ts
│   ├── doctor/     # schema, service, controller, routes
│   ├── schedule/   # schema, service, controller, routes
│   ├── appointment/# schema, service, controller, routes
│   ├── payment/    # Paymob integration (service, controller, routes)
│   ├── review/     # schema, service, controller, routes
│   └── admin/      # stats, users, pending doctors
│
├── workers/
│   ├── queue.definitions.ts    # BullMQ queue singletons + createWorker factory
│   ├── expiration.worker.ts    # Expires unpaid appointments, triggers refund
│   └── notification.worker.ts  # Sends emails + WebSocket events
│
├── app.ts                      # Express setup (middleware + routes + health + 404)
└── server.ts                   # HTTP + WS startup + graceful shutdown
```

---

## Background Workers

### Expiration Worker (`appointment-expiration` queue)

- Triggered by a BullMQ delayed job scheduled at `appointment.expiresAt`
- **Idempotent**: skips if `appointment.status !== pending`
- On expire: `status → expired` → refund if paid → invalidate cache → WS event → notification email
- Retry: 3 attempts, exponential backoff

### Notification Worker (`notifications` queue)

Handles these notification types:

- `appointment_confirmed` — on payment success
- `appointment_cancelled` — on cancellation
- `appointment_expired` — on expiration
- `appointment_completed` — doctor marks done
- `appointment_reminder` — 24h before appointment (scheduled via delayed job)

- Retry: 5 attempts, exponential backoff

---

## Security

| Concern              | Implementation                                                     |
| -------------------- | ------------------------------------------------------------------ |
| Password storage     | bcrypt (12 rounds)                                                 |
| OTP storage          | SHA-256 hashed in Redis with TTL                                   |
| JWT                  | Short-lived access token (15m) + long-lived refresh (7d)           |
| Refresh token reuse  | jti tracked in Redis → reuse triggers full revocation              |
| Rate limiting        | Sliding window Lua script (per IP for public, per userId for auth) |
| Webhook verification | HMAC-SHA512 (Paymob)                                               |
| Distributed lock     | Redis SET NX PX + Lua release script (atomic)                      |
| Request logging      | Pino with redaction (passwords, tokens, cookies)                   |
| Headers              | Helmet.js                                                          |
| Idempotency          | Idempotency-Key header caching in Redis (24h)                      |
| Double-booking       | Redis lock + DB unique index as last defense                       |

---

## Error Handling

All errors follow this format:

```json
{
  "success": false,
  "error": {
    "code": "SLOT_TAKEN",
    "message": "This slot is already booked",
    "details": []
  }
}
```

The global error handler (`src/middleware/error-handler.ts`) catches:

- `AppError` — operational errors with known codes
- `mongoose.Error.ValidationError` → 422 with field details
- `mongoose.Error.CastError` → 400 invalid ObjectId
- MongoDB duplicate key (code 11000) → 409
- Unhandled errors → 500 (message hidden in production)

---

## Health Check

```bash
GET /health

{
  "success": true,
  "data": {
    "status": "ok",
    "database": "connected",
    "redis": "ready",
    "uptime": 3600.5,
    "timestamp": "2024-01-15T10:00:00.000Z"
  }
}
```

---

## License

SONIC
