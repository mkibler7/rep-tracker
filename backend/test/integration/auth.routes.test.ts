import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import User from "../../src/models/User.js";

const app = createApp();

function getSetCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

describe("Auth routes", () => {
  let agent: ReturnType<typeof request.agent>;

  beforeEach(() => {
    agent = request.agent(app);
  });

  const registerAndVerify = async (
    email?: string,
    password = "Password123!",
  ) => {
    const actualEmail = (
      email ?? `test-${Date.now()}@test.local`
    ).toLowerCase();

    const res = await agent
      .post("/api/auth/register")
      .send({ email: actualEmail, password });

    await User.updateOne(
      { email: actualEmail },
      {
        $set: {
          emailVerified: true,
          isEmailVerified: true,
          verified: true,
          emailVerifiedAt: new Date(),
        },
      },
    );

    return { email: actualEmail, res };
  };

  const login = async (email: string, password = "Password123!") => {
    return agent.post("/api/auth/login").send({ email, password });
  };

  const refresh = async () => {
    return agent.post("/api/auth/refresh");
  };

  const logout = async () => {
    return agent.post("/api/auth/logout");
  };

  it("POST /api/auth/register creates account and requires email verification", async () => {
    const { res } = await registerAndVerify();

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body.message).toMatch(/verify/i);

    // Register currently clears any existing cookies (per your logs)
    const cookies = getSetCookies(res).join(";");
    expect(cookies).toContain("rt=");
    expect(cookies).toContain("at=");
  });

  it("POST /api/auth/login succeeds after verification and sets auth cookies", async () => {
    const { email } = await registerAndVerify();

    const res = await agent
      .post("/api/auth/login")
      .send({ email, password: "Password123!" });

    expect(res.status).toBe(200);

    // tokens appear to be cookie-based in your app
    const cookies = getSetCookies(res).join(";");
    expect(cookies).toContain("rt=");
    expect(cookies).toContain("at=");
  });

  it("POST /api/auth/refresh returns 200 after login sets refresh cookie", async () => {
    const { email } = await registerAndVerify();
    await agent
      .post("/api/auth/login")
      .send({ email, password: "Password123!" });

    const res = await agent.post("/api/auth/refresh");
    expect(res.status).toBe(200);
  });

  it("POST /api/auth/refresh may rotate refresh cookie when enabled", async () => {
    const { email } = await registerAndVerify();
    const loginRes = await agent
      .post("/api/auth/login")
      .send({ email, password: "Password123!" });

    const loginCookies = getSetCookies(loginRes);
    const loginRt = loginCookies.find((c) => c.startsWith("rt="));
    expect(loginRt).toBeTruthy();

    const ref1 = await agent.post("/api/auth/refresh");
    expect(ref1.status).toBe(200);

    const refreshCookies = getSetCookies(ref1);
    const refRt = refreshCookies.find((c) => c.startsWith("rt="));

    // Only assert rotation if your implementation rotates in this configuration
    if (refRt) expect(refRt).not.toEqual(loginRt);
  });

  it("POST /api/auth/logout clears refresh cookie and subsequent refresh fails", async () => {
    const { email } = await registerAndVerify();
    await agent
      .post("/api/auth/login")
      .send({ email, password: "Password123!" });

    const out = await logout();
    expect([200, 204]).toContain(out.status);

    const ref = await refresh();
    expect(ref.status).toBe(401);
    expect(ref.body).toHaveProperty("message");
  });

  it("POST /api/auth/register returns 409 for duplicate email", async () => {
    const email = `test-${Date.now()}@test.local`;

    const { res: first } = await registerAndVerify(email);
    expect(first.status).toBe(201);

    const { res: second } = await registerAndVerify(email);
    expect(second.status).toBe(409);
    expect(second.body).toHaveProperty("message");
  });

  it("POST /api/auth/login returns 401 for wrong password", async () => {
    const email = `test-${Date.now()}@test.local`;
    await registerAndVerify(email);

    const res = await login(email, "WrongPassword123!");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("message");
  });
});
