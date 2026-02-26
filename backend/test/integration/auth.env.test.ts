import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

describe("Auth router env wiring", () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = "development";

    // stop nodemailer during this env test
    process.env.DISABLE_EMAILS = "true";

    // make *any* auth limiter trigger fast
    process.env.AUTH_RATE_WINDOW_MS = "1000";
    process.env.AUTH_RATE_LIMIT = "1";
    process.env.LOGIN_RATE_WINDOW_MS = "1000";
    process.env.LOGIN_RATE_LIMIT = "1";

    vi.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("enables authLimiter when NODE_ENV !== test", async () => {
    const { createApp } = await import("../../app.js");
    const app = createApp();

    const ip = "1.2.3.4";

    const res1 = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", ip)
      .send({
        email: `t-${Date.now()}@test.local`,
        password: "Password123!",
      });
    expect(res1.status).not.toBe(429);

    const res2 = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", ip)
      .send({
        email: `t-${Date.now()}@test.local`,
        password: "Password123!",
      });
    expect(res2.status).toBe(429);
  });
});
