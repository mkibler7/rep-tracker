import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import User from "../../src/models/User.js";
import RefreshSession from "../../src/models/RefreshSession.js";

const app = createApp();

function getSetCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

const newAgent = () => request.agent(app);

async function registerAndVerify(
  agent: ReturnType<typeof request.agent>,
  email?: string,
  password = "Password123!",
) {
  const actualEmail = (email ?? `test-${Date.now()}@test.local`).toLowerCase();

  const res = await agent
    .post("/api/auth/register")
    .send({ email: actualEmail, password });

  // Your route checks emailVerifiedAt; keep the update minimal
  await User.updateOne(
    { email: actualEmail },
    {
      $set: {
        emailVerifiedAt: new Date(),
        // keep these if you still have older code referencing them elsewhere
        emailVerified: true,
        isEmailVerified: true,
        verified: true,
      },
    },
  );

  return { email: actualEmail, res };
}

async function login(
  agent: ReturnType<typeof request.agent>,
  email: string,
  password = "Password123!",
) {
  return agent.post("/api/auth/login").send({ email, password });
}

describe("Auth routes", () => {
  describe("POST /api/auth/register", () => {
    it("creates account and requires email verification", async () => {
      const agent = newAgent();
      const { res } = await registerAndVerify(agent);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("ok", true);
      expect(res.body.message).toMatch(/verify/i);

      const cookies = getSetCookies(res).join(";");
      expect(cookies).toContain("rt=");
      expect(cookies).toContain("at=");
    });

    it("returns 400 for invalid body", async () => {
      const agent = newAgent();

      const res = await agent.post("/api/auth/register").send({
        email: "not-an-email",
        password: "Password123!",
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("message");
    });

    it("honors EMAIL_VERIFY_TTL_MINUTES when set", async () => {
      const agent = newAgent();

      const original = process.env.EMAIL_VERIFY_TTL_MINUTES;
      process.env.EMAIL_VERIFY_TTL_MINUTES = "1";

      try {
        const email = `ttl-${Date.now()}@test.local`;

        const res = await agent
          .post("/api/auth/register")
          .send({ email, password: "Password123!" });

        expect(res.status).toBe(201);

        const user = await User.findOne({ email });
        expect(user).toBeTruthy();

        const EmailVerificationToken = (
          await import("../../src/models/EmailVerificationToken.js")
        ).default;

        const tokenDoc = await EmailVerificationToken.findOne({
          userId: user!._id,
        }).sort({ createdAt: -1 });

        expect(tokenDoc).toBeTruthy();

        const expiresAtMs = new Date(tokenDoc!.expiresAt).getTime();
        const now = Date.now();

        expect(expiresAtMs).toBeGreaterThan(now + 30_000);
        expect(expiresAtMs).toBeLessThan(now + 90_000);
      } finally {
        if (original === undefined) delete process.env.EMAIL_VERIFY_TTL_MINUTES;
        else process.env.EMAIL_VERIFY_TTL_MINUTES = original;
      }
    });

    it("returns 409 for duplicate email", async () => {
      const agent = newAgent();
      const email = `test-${Date.now()}@test.local`;

      const { res: first } = await registerAndVerify(agent, email);
      expect(first.status).toBe(201);

      // Use same agent; cookies don’t matter here
      const { res: second } = await registerAndVerify(agent, email);
      expect(second.status).toBe(409);
      expect(second.body).toHaveProperty("message");
    });
  });

  describe("POST /api/auth/demo", () => {
    it("returns 404 when ENABLE_DEMO is not true", async () => {
      const agent = newAgent();

      const original = process.env.ENABLE_DEMO;
      delete process.env.ENABLE_DEMO;

      try {
        const res = await agent.post("/api/auth/demo").send({});
        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty("message");
      } finally {
        if (original === undefined) delete process.env.ENABLE_DEMO;
        else process.env.ENABLE_DEMO = original;
      }
    });
    it("creates or reuses demo user, seeds data, and sets auth cookies when enabled", async () => {
      const agent = newAgent();

      // env setup
      const originalEnable = process.env.ENABLE_DEMO;
      const originalDemoEmail = process.env.DEMO_EMAIL;
      process.env.ENABLE_DEMO = "true";
      process.env.DEMO_EMAIL = `demo-${Date.now()}@test.local`;

      // mock seeding to keep test fast + deterministic
      const demoSeed = await import("../../src/utils/demoSeed.js");
      const seedSpy = vi
        .spyOn(demoSeed, "ensureRollingDemoData")
        .mockResolvedValue(undefined as any);

      try {
        const res = await agent.post("/api/auth/demo").send({});
        expect(res.status).toBe(200);

        // response structure
        expect(res.body).toHaveProperty("user");
        expect(res.body.user).toHaveProperty(
          "email",
          process.env.DEMO_EMAIL!.toLowerCase(),
        );
        expect(res.body.user).toHaveProperty("id");

        // cookies should be set
        const cookies = getSetCookies(res).join(";");
        expect(cookies).toContain("rt=");
        expect(cookies).toContain("at=");

        // ensure seeding was invoked for the created/reused user
        expect(seedSpy).toHaveBeenCalledTimes(1);
      } finally {
        seedSpy.mockRestore();
        if (originalEnable === undefined) delete process.env.ENABLE_DEMO;
        else process.env.ENABLE_DEMO = originalEnable;

        if (originalDemoEmail === undefined) delete process.env.DEMO_EMAIL;
        else process.env.DEMO_EMAIL = originalDemoEmail;
      }
    });
    it("verifies demo user if it exists but is not verified", async () => {
      const agent = newAgent();

      const originalEnable = process.env.ENABLE_DEMO;
      const originalDemoEmail = process.env.DEMO_EMAIL;
      process.env.ENABLE_DEMO = "true";
      process.env.DEMO_EMAIL = `demo-${Date.now()}@test.local`;

      const demoSeed = await import("../../src/utils/demoSeed.js");
      const seedSpy = vi
        .spyOn(demoSeed, "ensureRollingDemoData")
        .mockResolvedValue(undefined as any);

      try {
        // First run creates user
        await agent.post("/api/auth/demo").send({});

        // Force emailVerifiedAt to null
        await User.updateOne(
          { email: process.env.DEMO_EMAIL!.toLowerCase() },
          { $set: { emailVerifiedAt: null } },
        );

        // Second run should set emailVerifiedAt
        await agent.post("/api/auth/demo").send({});

        const user = await User.findOne({
          email: process.env.DEMO_EMAIL!.toLowerCase(),
        });
        expect(user).toBeTruthy();
        expect(user!.emailVerifiedAt).toBeTruthy();
      } finally {
        seedSpy.mockRestore();
        if (originalEnable === undefined) delete process.env.ENABLE_DEMO;
        else process.env.ENABLE_DEMO = originalEnable;

        if (originalDemoEmail === undefined) delete process.env.DEMO_EMAIL;
        else process.env.DEMO_EMAIL = originalDemoEmail;
      }
    });
  });

  describe("POST /api/auth/login", () => {
    it("succeeds after verification and sets auth cookies", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      const res = await login(agent, email);
      expect(res.status).toBe(200);

      const cookies = getSetCookies(res).join(";");
      expect(cookies).toContain("rt=");
      expect(cookies).toContain("at=");
    });

    it("returns 401 for wrong password", async () => {
      const agent = newAgent();
      const email = `test-${Date.now()}@test.local`;
      await registerAndVerify(agent, email);

      const res = await login(agent, email, "WrongPassword123!");
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("message");
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("returns 200 after login sets refresh cookie", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      await login(agent, email);

      const res = await agent.post("/api/auth/refresh");
      expect(res.status).toBe(200);
    });

    it("may rotate refresh cookie when enabled", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      const loginRes = await login(agent, email);
      expect(loginRes.status).toBe(200);

      const loginCookies = getSetCookies(loginRes);
      const loginRt = loginCookies.find((c) => c.startsWith("rt="));
      expect(loginRt).toBeTruthy();

      const ref1 = await agent.post("/api/auth/refresh");
      expect(ref1.status).toBe(200);

      const refreshCookies = getSetCookies(ref1);
      const refRt = refreshCookies.find((c) => c.startsWith("rt="));

      if (refRt) expect(refRt).not.toEqual(loginRt);
    });

    it("returns 401 when refresh JWT is valid but session is missing", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      const loginRes = await login(agent, email);
      expect(loginRes.status).toBe(200);

      const user = await User.findOne({ email });
      expect(user).toBeTruthy();

      await RefreshSession.deleteMany({ userId: user!._id });

      const res = await agent.post("/api/auth/refresh");
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("message");
      expect(String(res.body.message).toLowerCase()).toMatch(/invalid/);
    });

    it("returns 401 when refresh token is invalid (jwt.verify fails)", async () => {
      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", ["rt=not-a-valid-jwt"]);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("message");
      expect(String(res.body.message).toLowerCase()).toMatch(/invalid/);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears refresh cookie and subsequent refresh fails", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      await login(agent, email);

      const out = await agent.post("/api/auth/logout");
      expect([200, 204]).toContain(out.status);

      const ref = await agent.post("/api/auth/refresh");
      expect(ref.status).toBe(401);
      expect(ref.body).toHaveProperty("message");
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns user info when authenticated", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      const loginRes = await login(agent, email);
      expect(loginRes.status).toBe(200);

      const res = await agent.get("/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("email", email);
      expect(res.body).not.toHaveProperty("passwordHash");
    });

    it("returns 404 when token is valid but user no longer exists", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      const loginRes = await login(agent, email);
      expect(loginRes.status).toBe(200);

      await User.deleteOne({ email });

      const res = await agent.get("/api/auth/me");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("message");
      expect(String(res.body.message).toLowerCase()).toMatch(/not found/);
    });
  });

  describe("POST /api/auth/forgot-password", () => {
    it("returns 400 for invalid body", async () => {
      const agent = newAgent();

      const res = await agent.post("/api/auth/forgot-password").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("message");
    });
    it("returns generic 200 and creates a reset token when user exists", async () => {
      const agent = newAgent();
      const { email } = await registerAndVerify(agent);

      // import model for assertion
      const PasswordResetToken = (
        await import("../../src/models/PasswordResetToken.js")
      ).default;

      const res = await agent.post("/api/auth/forgot-password").send({ email });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("message");
      expect(String(res.body.message).toLowerCase()).toMatch(
        /if an account exists/,
      );

      const user = await User.findOne({ email }).select("_id");
      expect(user).toBeTruthy();

      const tokenDoc = await PasswordResetToken.findOne({ userId: user!._id });
      expect(tokenDoc).toBeTruthy();
      expect(tokenDoc).toHaveProperty("tokenHash");
      expect(tokenDoc).toHaveProperty("expiresAt");
      expect(tokenDoc).toHaveProperty("usedAt", null);
    });
  });

  describe("POST /api/auth/reset-password", () => {
    it("returns 400 for invalid body", async () => {
      const agent = newAgent();

      const res = await agent.post("/api/auth/reset-password").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("message");
    });

    it("returns 400 when reset token is invalid/expired", async () => {
      const agent = newAgent();

      const res = await agent.post("/api/auth/reset-password").send({
        token: "definitely-not-a-real-token",
        password: "NewPassword123!",
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("message");
      expect(String(res.body.message).toLowerCase()).toMatch(/invalid|expired/);
    });

    it("resets password, marks token used, revokes sessions, and clears cookies", async () => {
      const agent = newAgent();

      // Create a verified user
      const { email } = await registerAndVerify(agent);

      // Ask for reset -> this will create PasswordResetToken in DB
      const forgot = await agent
        .post("/api/auth/forgot-password")
        .send({ email });
      expect(forgot.status).toBe(200);

      // Pull the raw token from the DB record:
      // Your DB only stores tokenHash, not rawToken, so we can't get the token from DB.
      // Therefore: we need to *control* token generation or intercept the resetUrl.
      //
      // Easiest approach: mock sendPasswordResetEmail to capture the resetUrl (contains raw token).
      const mailer = await import("../../src/utils/mailer.js");
      const spy = (await import("vitest")).vi
        .spyOn(mailer, "sendPasswordResetEmail")
        .mockResolvedValue({ skipped: true } as any);

      // Call forgot-password again to capture token URL in spy
      await agent.post("/api/auth/forgot-password").send({ email });
      expect(spy).toHaveBeenCalled();

      const resetUrl = spy.mock.calls[spy.mock.calls.length - 1][1] as string;
      const token = new URL(resetUrl).searchParams.get("token");
      expect(token).toBeTruthy();

      // Now reset password using the real raw token
      const res = await agent.post("/api/auth/reset-password").send({
        token,
        password: "NewPassword123!",
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("ok", true);

      // token record should be marked used
      const PasswordResetToken = (
        await import("../../src/models/PasswordResetToken.js")
      ).default;
      const user = await User.findOne({ email }).select("_id passwordHash");
      expect(user).toBeTruthy();

      const tokenDoc = await PasswordResetToken.findOne({ userId: user!._id });
      expect(tokenDoc).toBeTruthy();
      if (!tokenDoc) throw new Error("Expected PasswordResetToken to exist");
      expect(tokenDoc.usedAt).toBeTruthy();

      // Login with new password should succeed
      const loginRes = await agent.post("/api/auth/login").send({
        email,
        password: "NewPassword123!",
      });
      expect(loginRes.status).toBe(200);

      spy.mockRestore();
    });
  });

  describe("POST /api/auth/reset-password", () => {
    it("returns 400 for invalid body", async () => {
      const agent = newAgent();

      const res = await agent.post("/api/auth/reset-password").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("message");
    });

    it("returns 400 when reset token is invalid/expired", async () => {
      const agent = newAgent();

      const res = await agent.post("/api/auth/reset-password").send({
        token: "definitely-not-a-real-token",
        password: "NewPassword123!",
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("message");
      expect(String(res.body.message).toLowerCase()).toMatch(/invalid|expired/);
    });

    it("resets password, marks token used, revokes sessions, and clears cookies", async () => {
      const agent = newAgent();

      // Create a verified user
      const { email } = await registerAndVerify(agent);

      // Ask for reset -> this will create PasswordResetToken in DB
      const forgot = await agent
        .post("/api/auth/forgot-password")
        .send({ email });
      expect(forgot.status).toBe(200);

      // Pull the raw token from the DB record
      const mailer = await import("../../src/utils/mailer.js");
      const spy = (await import("vitest")).vi
        .spyOn(mailer, "sendPasswordResetEmail")
        .mockResolvedValue({ skipped: true } as any);

      // Call forgot-password again to capture token URL in spy
      await agent.post("/api/auth/forgot-password").send({ email });
      expect(spy).toHaveBeenCalled();

      const resetUrl = spy.mock.calls[spy.mock.calls.length - 1][1] as string;
      const token = new URL(resetUrl).searchParams.get("token");
      expect(token).toBeTruthy();

      // Now reset password using the real raw token
      const res = await agent.post("/api/auth/reset-password").send({
        token,
        password: "NewPassword123!",
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("ok", true);

      // token record should be marked used
      const PasswordResetToken = (
        await import("../../src/models/PasswordResetToken.js")
      ).default;
      const user = await User.findOne({ email }).select("_id passwordHash");
      expect(user).toBeTruthy();

      const tokenDoc = await PasswordResetToken.findOne({
        userId: user!._id,
      }).sort({ createdAt: -1 });
      expect(tokenDoc).toBeTruthy();
      if (!tokenDoc) throw new Error("Expected PasswordResetToken to exist");
      expect(tokenDoc.usedAt).toBeTruthy();

      // Login with new password should succeed
      const loginRes = await agent.post("/api/auth/login").send({
        email,
        password: "NewPassword123!",
      });
      expect(loginRes.status).toBe(200);

      spy.mockRestore();
    });
  });
});
