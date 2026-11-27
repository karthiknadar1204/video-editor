import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import nodemailer from "nodemailer";
import { z } from "zod";
import { db } from "./db/client";
import * as schema from "./db/schema";

const config = z.object({
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  MAIL_FROM: z.string().min(1),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
}).parse(process.env);

const appUrl = new URL(config.BETTER_AUTH_URL);
export const appOrigin = appUrl.origin;
const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname);
if (appUrl.protocol !== "https:" && !(isLoopback && appUrl.protocol === "http:")) {
  throw new Error("BETTER_AUTH_URL must use HTTPS outside local development.");
}
const smtp = new URL(config.SMTP_URL);
if (smtp.protocol === "smtp:" && !["localhost", "127.0.0.1", "[::1]"].includes(smtp.hostname)) {
  smtp.searchParams.set("requireTLS", "true");
  smtp.searchParams.delete("ignoreTLS");
}
const mail = nodemailer.createTransport(smtp.href, { from: config.MAIL_FROM });

export const auth = betterAuth({
  appName: "Cutroom",
  baseURL: appOrigin,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [appOrigin],
  database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
  advanced: { useSecureCookies: appUrl.protocol === "https:" },
  session: { expiresIn: 60 * 60 * 24 * 7, disableSessionRefresh: true },
  rateLimit: { enabled: true, storage: "database" },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      await mail.sendMail({ to: user.email, subject: "Reset your Cutroom password", text: "Choose a new password for Cutroom.\n\n" + url });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      await mail.sendMail({ to: user.email, subject: "Verify your Cutroom email", text: "Verify your email to open your Cutroom workspace.\n\n" + url });
    },
  },
});
