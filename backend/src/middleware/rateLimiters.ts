import rateLimit from "express-rate-limit";

const num = (key: string, fallback: number) => {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

// General API limiter (reasonable baseline)
export const apiLimiter = rateLimit({
  windowMs: num("API_RATE_WINDOW_MS", 15 * 60 * 1000),
  limit: num("API_RATE_LIMIT", 300),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  message: { message: "API rate limit hit." },
});

// Auth limiter (stricter)
export const authLimiter = rateLimit({
  windowMs: num("AUTH_RATE_WINDOW_MS", 15 * 60 * 1000),
  limit: num("AUTH_RATE_LIMIT", 30),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  message: { message: "Auth rate limit hit." },
});

// Login limiter (strictest)
export const loginLimiter = rateLimit({
  windowMs: num("LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
  limit: num("LOGIN_RATE_LIMIT", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again later." },
});
