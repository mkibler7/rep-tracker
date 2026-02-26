import { describe, it, expect, beforeEach } from "vitest";
import {
  signAccessToken,
  signRefreshToken,
  setAccessCookie,
  clearAccessCookie,
  setRefreshCookie,
  clearRefreshCookie,
  setSessionMarkerCookie,
  clearSessionMarkerCookie,
} from "../../src/utils/tokens.js";

function mockRes() {
  return {
    cookie: (name: string, value: any, opts: any) => {
      calls.cookies.push({ name, value, opts });
    },
    clearCookie: (name: string, opts: any) => {
      calls.clears.push({ name, opts });
    },
  } as any;
}

const calls = {
  cookies: [] as any[],
  clears: [] as any[],
};

describe("tokens.ts branch coverage", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // reset env + captured calls
    process.env = { ...originalEnv };
    calls.cookies = [];
    calls.clears = [];

    // required secrets for sign* functions
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.JWT_REFRESH_SECRET = "test_refresh_secret";
  });

  it("mustGetEnv throws when required env var missing (via signAccessToken)", () => {
    delete process.env.JWT_ACCESS_SECRET;
    expect(() => signAccessToken("u1")).toThrow(
      /Missing env var: JWT_ACCESS_SECRET/,
    );
  });

  it("signAccessToken uses default ACCESS_TOKEN_TTL when unset", () => {
    delete process.env.ACCESS_TOKEN_TTL;
    const token = signAccessToken("u1");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });

  it("signRefreshToken uses REFRESH_TOKEN_TTL_DAYS default when unset", () => {
    delete process.env.REFRESH_TOKEN_TTL_DAYS;
    const token = signRefreshToken("u1");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });

  it("setAccessCookie parses ttl units (s, m, h, d) and falls back for invalid", () => {
    const res = mockRes();

    // seconds
    process.env.ACCESS_TOKEN_TTL = "10s";
    setAccessCookie(res, "at1");
    expect(calls.cookies.at(-1).opts.maxAge).toBe(10_000);

    // minutes
    process.env.ACCESS_TOKEN_TTL = "2m";
    setAccessCookie(res, "at2");
    expect(calls.cookies.at(-1).opts.maxAge).toBe(2 * 60_000);

    // hours
    process.env.ACCESS_TOKEN_TTL = "1h";
    setAccessCookie(res, "at3");
    expect(calls.cookies.at(-1).opts.maxAge).toBe(60 * 60_000);

    // days
    process.env.ACCESS_TOKEN_TTL = "1d";
    setAccessCookie(res, "at4");
    expect(calls.cookies.at(-1).opts.maxAge).toBe(24 * 60 * 60_000);

    // invalid => fallback 15m
    process.env.ACCESS_TOKEN_TTL = "bogus";
    setAccessCookie(res, "at5");
    expect(calls.cookies.at(-1).opts.maxAge).toBe(15 * 60_000);
  });

  it("secure cookie flag: production + COOKIE_SECURE=false => secure false", () => {
    const res = mockRes();
    process.env.NODE_ENV = "production";
    process.env.COOKIE_SECURE = "false";

    setRefreshCookie(res, "rt");
    expect(calls.cookies.at(-1).opts.secure).toBe(false);

    clearRefreshCookie(res);
    expect(calls.clears.at(-1).opts.secure).toBe(false);

    setAccessCookie(res, "at");
    expect(calls.cookies.at(-1).opts.secure).toBe(false);

    clearAccessCookie(res);
    expect(calls.clears.at(-1).opts.secure).toBe(false);
  });

  it("secure cookie flag: production + COOKIE_SECURE unset => secure true", () => {
    const res = mockRes();
    process.env.NODE_ENV = "production";
    delete process.env.COOKIE_SECURE;

    setAccessCookie(res, "at");
    expect(calls.cookies.at(-1).opts.secure).toBe(true);
  });

  it("secure cookie flag: non-production => secure false", () => {
    const res = mockRes();
    process.env.NODE_ENV = "test";

    setAccessCookie(res, "at");
    expect(calls.cookies.at(-1).opts.secure).toBe(false);
  });

  it("session marker cookie uses COOKIE_SAMESITE fallback and includes domain when set", () => {
    const res = mockRes();

    // fallback sameSite = lax, no domain
    delete process.env.COOKIE_SAMESITE;
    delete process.env.COOKIE_DOMAIN;

    setSessionMarkerCookie(res);
    expect(calls.cookies.at(-1).opts.sameSite).toBe("lax");
    expect(calls.cookies.at(-1).opts.domain).toBeUndefined();

    // explicit sameSite + domain branch
    process.env.COOKIE_SAMESITE = "strict";
    process.env.COOKIE_DOMAIN = "example.com";

    setSessionMarkerCookie(res);
    expect(calls.cookies.at(-1).opts.sameSite).toBe("strict");
    expect(calls.cookies.at(-1).opts.domain).toBe("example.com");
  });

  it("clearSessionMarkerCookie includes domain only when set", () => {
    const res = mockRes();

    delete process.env.COOKIE_DOMAIN;
    clearSessionMarkerCookie(res);
    expect(calls.clears.at(-1).opts.domain).toBeUndefined();

    process.env.COOKIE_DOMAIN = "example.com";
    clearSessionMarkerCookie(res);
    expect(calls.clears.at(-1).opts.domain).toBe("example.com");
  });
});
