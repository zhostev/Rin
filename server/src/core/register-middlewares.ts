import { cors } from "hono/cors";
import { timing } from "hono/timing";
import { authMiddleware, initContainerMiddleware } from "./hono-middleware";
import type { RinApp } from "./app-types";

export function registerMiddlewares(app: RinApp) {
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        const configured = c.env.FRONTEND_URL?.trim();
        if (!configured || !origin) return undefined;

        try {
          const allowedOrigin = new URL(configured).origin;
          return origin === allowedOrigin ? origin : undefined;
        } catch {
          return undefined;
        }
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-csrf-token"],
      maxAge: 600,
      credentials: true,
    }),
  );

  app.use("*", timing({ totalDescription: "" }));
  app.use("*", initContainerMiddleware);
  app.use("*", authMiddleware);
}
