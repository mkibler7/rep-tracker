import { Router, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { ensureRollingDemoData } from "../utils/demoSeed.js";
import User from "../models/User.js";
import RefreshSession from "../models/RefreshSession.js";
import crypto from "crypto";
import { loginSchema, registerSchema } from "../validators/authInput.js";
import { authLimiter, loginLimiter } from "../middleware/rateLimiters.js";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../validators/passwordResetInput.js";
import {
  clearAccessCookie,
  clearRefreshCookie,
  hashToken,
  setAccessCookie,
  setRefreshCookie,
  signAccessToken,
  signRefreshToken,
} from "../utils/tokens.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import EmailVerificationToken from "../models/EmailVerificationToken.js";
import { sendPasswordResetEmail, sendVerifyEmail } from "../utils/mailer.js";
import z from "zod";

import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Apply to all auth routes in non test conditions
if (process.env.NODE_ENV !== "test") {
  router.use(authLimiter);
}

router.post("/register", async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success)
    return res.status(400).json({ message: parsed.error.message });

  const { email, password, displayName } = parsed.data;

  const existing = await User.findOne({ email });
  if (existing)
    return res.status(409).json({ message: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({
    email,
    passwordHash,
    displayName: displayName?.trim() ?? "",
    emailVerifiedAt: null,
  });

  // Invalidate prior unused verify tokens for this user
  await EmailVerificationToken.updateMany(
    { userId: user._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  // Create new verification token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  const minutes = Number(process.env.EMAIL_VERIFY_TTL_MINUTES ?? "60");
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  await EmailVerificationToken.create({
    userId: user._id,
    tokenHash,
    expiresAt,
    usedAt: null,
  });

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
  const verifyUrl = `${frontendOrigin}/verify-email?token=${encodeURIComponent(
    rawToken,
  )}`;

  await sendVerifyEmail(user.email, verifyUrl);

  // Do NOT set cookies here; they must verify first
  clearRefreshCookie(res);
  clearAccessCookie(res);

  return res.status(201).json({
    ok: true,
    message: "Account created. Please verify your email to continue.",
  });
});

// Demo login route for easy access without registration
router.post("/demo", async (_req: Request, res: Response) => {
  // Safety switch so you can disable quickly if needed
  if (process.env.ENABLE_DEMO !== "true") {
    return res.status(404).json({ message: "Not found" });
  }

  const demoEmail = (
    process.env.DEMO_EMAIL ?? "demo@set-tracker.com"
  ).toLowerCase();

  // Find or create the demo user
  let user = await User.findOne({ email: demoEmail });

  if (!user) {
    // random password hash; nobody should be using password login for demo
    const randomPass = crypto.randomBytes(24).toString("hex");
    const passwordHash = await bcrypt.hash(randomPass, 12);

    user = await User.create({
      email: demoEmail,
      passwordHash,
      displayName: "John Smith",
      roles: ["user"],
      emailVerifiedAt: new Date(),
    });
  } else if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }

  // Seed/refresh rolling last-7-days data
  await ensureRollingDemoData(String(user._id));

  // Issue session cookies (same as login)
  const refreshToken = signRefreshToken(String(user._id));
  const tokenHash = hashToken(refreshToken);

  const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? "30");
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await RefreshSession.create({ userId: user._id, tokenHash, expiresAt });

  setRefreshCookie(res, refreshToken);

  const accessToken = signAccessToken(String(user._id));
  setAccessCookie(res, accessToken);

  return res.json({
    user: {
      id: String(user._id),
      email: user.email,
      displayName: user.displayName ?? "SetTracker Demo",
    },
  });
});

router.post(
  "/login",
  ...(process.env.NODE_ENV === "test" ? [] : [loginLimiter]),
  async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success)
      return res.status(400).json({ message: parsed.error.message });

    const { email, password } = parsed.data;

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    if (!user.emailVerifiedAt) {
      return res.status(403).json({ message: "Email not verified" });
    }

    const refreshToken = signRefreshToken(String(user._id));
    const tokenHash = hashToken(refreshToken);

    const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? "30");
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await RefreshSession.create({ userId: user._id, tokenHash, expiresAt });

    setRefreshCookie(res, refreshToken);

    const accessToken = signAccessToken(String(user._id));
    setAccessCookie(res, accessToken);
    // setSessionMarkerCookie(res);

    res.json({
      user: {
        id: String(user._id),
        email: user.email,
        displayName: user.displayName ?? "",
      },
    });
  },
);

router.post("/refresh", async (req: Request, res: Response) => {
  const token = req.cookies?.rt as string | undefined;

  // If no refresh token cookie, clear any access cookie too (defensive)
  if (!token) {
    clearRefreshCookie(res);
    clearAccessCookie(res);
    // clearSessionMarkerCookie(res);
    return res.status(401).json({ message: "Missing refresh token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as {
      sub: string;
    };
    const tokenHash = hashToken(token);

    const session = await RefreshSession.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });

    // If session invalid/expired/revoked: clear cookies so client stops sending junk
    if (!session) {
      clearRefreshCookie(res);
      clearAccessCookie(res);
      // clearSessionMarkerCookie(res);
      return res.status(401).json({ message: "Refresh token invalid" });
    }

    // Rotate: revoke old
    session.revokedAt = new Date();
    await session.save();

    // Issue new refresh
    const newRefreshToken = signRefreshToken(payload.sub);
    const newHash = hashToken(newRefreshToken);

    const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? "30");
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await RefreshSession.create({
      userId: payload.sub,
      tokenHash: newHash,
      expiresAt,
    });
    setRefreshCookie(res, newRefreshToken);

    // Issue new access
    const accessToken = signAccessToken(payload.sub);
    setAccessCookie(res, accessToken);
    // setSessionMarkerCookie(res);

    // Cookie-based auth: frontend does not need the token body
    return res.json({ ok: true });
  } catch {
    // JWT verify failed (expired / invalid signature): clear cookies here too
    clearRefreshCookie(res);
    clearAccessCookie(res);
    // clearSessionMarkerCookie(res);
    return res.status(401).json({ message: "Refresh token invalid" });
  }
});

router.post("/logout", async (req: Request, res: Response) => {
  const token = req.cookies?.rt as string | undefined;

  if (token) {
    const tokenHash = hashToken(token);
    await RefreshSession.updateOne(
      { tokenHash },
      { $set: { revokedAt: new Date() } },
    );
  }

  clearRefreshCookie(res);
  clearAccessCookie(res);
  // clearSessionMarkerCookie(res);

  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = await User.findById(userId).select("email displayName");
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? "",
  });
});

router.post("/forgot-password", async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.message });
  }

  const { email } = parsed.data;

  // Always respond 200 to avoid account enumeration
  const generic = {
    message:
      "If an account exists for that email, we sent a password reset link.",
  };

  const user = await User.findOne({ email }).select("_id email");
  if (!user) return res.json(generic);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  const minutes = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? "30");
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  // Invalidate prior unused tokens for this user
  await PasswordResetToken.updateMany(
    { userId: user._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );

  await PasswordResetToken.create({
    userId: user._id,
    tokenHash,
    expiresAt,
    usedAt: null,
  });

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
  const resetUrl = `${frontendOrigin}/reset-password?token=${encodeURIComponent(
    rawToken,
  )}`;

  await sendPasswordResetEmail(user.email, resetUrl);

  return res.json(generic);
});

router.post("/reset-password", async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.message });
  }

  const { token, password } = parsed.data;

  const tokenHash = hashToken(token);

  const record = await PasswordResetToken.findOne({
    tokenHash,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!record) {
    return res
      .status(400)
      .json({ message: "Reset link is invalid or expired." });
  }

  const user = await User.findById(record.userId);
  if (!user) {
    return res
      .status(400)
      .json({ message: "Reset link is invalid or expired." });
  }

  user.passwordHash = await bcrypt.hash(password, 12);
  await user.save();

  record.usedAt = new Date();
  await record.save();

  // Revoke refresh sessions to force re-login on other devices
  await RefreshSession.updateMany(
    { userId: user._id },
    { $set: { revokedAt: new Date() } },
  );

  clearRefreshCookie(res);
  clearAccessCookie(res);

  return res.json({ ok: true });
});

router.post("/verify-email", async (req: Request, res: Response) => {
  const schema = z.object({ token: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.message });
  }

  const tokenHash = hashToken(parsed.data.token);

  const record = await EmailVerificationToken.findOne({
    tokenHash,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!record) {
    return res
      .status(400)
      .json({ message: "Verification link is invalid or expired." });
  }

  const user = await User.findById(record.userId);
  if (!user) {
    return res
      .status(400)
      .json({ message: "Verification link is invalid or expired." });
  }

  // If already verified, still succeed
  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }

  record.usedAt = new Date();
  await record.save();

  return res.json({ ok: true });
});

router.post("/resend-verification", async (req: Request, res: Response) => {
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.message });
  }

  // Generic response to avoid enumeration
  const generic = {
    message:
      "If an account exists for that email, we sent a verification link.",
  };

  const email = parsed.data.email.trim().toLowerCase();
  const user = await User.findOne({ email }).select(
    "_id email emailVerifiedAt",
  );
  if (!user) return res.json(generic);
  if (user.emailVerifiedAt) return res.json(generic);

  await EmailVerificationToken.updateMany(
    { userId: user._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  const minutes = Number(process.env.EMAIL_VERIFY_TTL_MINUTES ?? "60");
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  await EmailVerificationToken.create({
    userId: user._id,
    tokenHash,
    expiresAt,
    usedAt: null,
  });

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
  const verifyUrl = `${frontendOrigin}/verify-email?token=${encodeURIComponent(
    rawToken,
  )}`;

  await sendVerifyEmail(user.email, verifyUrl);

  return res.json(generic);
});

export default router;
