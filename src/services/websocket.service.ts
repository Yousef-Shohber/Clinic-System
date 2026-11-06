import { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import getRedis from "../config/redis";
import getEnv from "../config/env";
import { logger } from "../config/logger";
import { JwtPayload } from "../types/express";

let _io: SocketServer;
let _pubClient:
  | ReturnType<ReturnType<typeof getRedis>["duplicate"]>
  | undefined;
let _subClient:
  | ReturnType<ReturnType<typeof getRedis>["duplicate"]>
  | undefined;

export function initWebSocket(httpServer: HttpServer): SocketServer {
  const env = getEnv();
  const redis = getRedis();

  _io = new SocketServer(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    transports: ["websocket", "polling"],
  });

  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  _pubClient = pubClient;
  _subClient = subClient;
  _io.adapter(createAdapter(pubClient, subClient));

  _io.use((socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error("No token provided"));

    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
      socket.data.userId = decoded.userId;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  _io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    void socket.join(`user:${userId}`);
    logger.info({ userId, socketId: socket.id }, "WS client connected");

    socket.on("disconnect", () => {
      logger.info({ userId, socketId: socket.id }, "WS client disconnected");
    });
  });

  logger.info("WebSocket server initialized");
  return _io;
}

/** Disconnects every socket and closes the underlying HTTP server too. */
export async function closeWebSocket(): Promise<void> {
  if (_io) {
    await new Promise<void>((resolve) => {
      _io.close(() => resolve());
    });
  }
  await Promise.allSettled([_pubClient?.quit(), _subClient?.quit()]);
}

export function getIO(): SocketServer {
  if (!_io) throw new Error("WebSocket server not initialized");
  return _io;
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  try {
    getIO().to(`user:${userId}`).emit(event, data);
  } catch (err) {
    logger.error({ err, userId, event }, "Failed to emit WS event");
  }
}

export const wsEmit = {
  appointmentCreated(
    userId: string,
    data: {
      appointmentId: string;
      doctorId: string;
      date: string;
      startTime: string;
    },
  ) {
    emitToUser(userId, "appointment:created", data);
  },

  appointmentConfirmed(userId: string, appointmentId: string) {
    emitToUser(userId, "appointment:confirmed", { appointmentId });
  },

  appointmentCancelled(userId: string, appointmentId: string) {
    emitToUser(userId, "appointment:cancelled", { appointmentId });
  },

  appointmentCompleted(userId: string, appointmentId: string) {
    emitToUser(userId, "appointment:completed", { appointmentId });
  },

  appointmentExpired(userId: string, appointmentId: string) {
    emitToUser(userId, "appointment:expired", { appointmentId });
  },

  appointmentReminder(
    userId: string,
    data: { appointmentId: string; date: string; startTime: string },
  ) {
    emitToUser(userId, "appointment:reminder", data);
  },
};
