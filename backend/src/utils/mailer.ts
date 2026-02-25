import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "465");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM;
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO;

function smtpConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_FROM);
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST!,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // Resend commonly uses 465 secure
    auth: {
      user: SMTP_USER!,
      pass: SMTP_PASS!, // Resend: API key is the password
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });

  return transporter;
}

export async function sendVerifyEmail(to: string, verifyUrl: string) {
  if (process.env.NODE_ENV === "test") {
    return { skipped: true };
  }

  const tx = getTransporter();

  await tx.sendMail({
    from: MAIL_FROM!,
    to,
    replyTo: MAIL_REPLY_TO,
    subject: "Verify your e-mail for your new SetTracker account!",
    text: `Verify your email by clicking this link: ${verifyUrl}`,
    html: `
      <p>Verify your e-mail by clicking the link below:</p>
      <p><a href="${verifyUrl}">Verify E-mail</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    `,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  if (process.env.NODE_ENV === "test") {
    return { skipped: true };
  }
  const tx = getTransporter();

  await tx.sendMail({
    from: MAIL_FROM!,
    to,
    replyTo: MAIL_REPLY_TO,
    subject: "Reset your SetTracker password",
    text: `Reset your password using this link: ${resetUrl}`,
    html: `
      <p>Reset your password by clicking the link below:</p>
      <p><a href="${resetUrl}">Reset Password</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    `,
  });
}
