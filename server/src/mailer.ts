import nodemailer from "nodemailer";
import { logger } from "./logger";

export class Mailer {
  private from: string;
  private enabled: boolean;

  constructor(defaultFrom: string) {
    this.from = defaultFrom;
    this.enabled = process.env.EMAIL_ENABLED === "true";
  }

  async send(to: string[], subject: string, body: string): Promise<void> {
    if (!this.enabled) {
      logger.debug("Email disabled – skipping send", { to, subject });
      return;
    }
    try {
      const transport = nodemailer.createTransport({
        host: process.env.EMAIL_SERVER ?? "localhost",
        port: parseInt(process.env.EMAIL_PORT ?? "25", 10),
        secure: process.env.EMAIL_SECURE === "true",
      });
      await transport.sendMail({ from: this.from, to: to.join(","), subject, text: body });
      logger.info("Email sent", { to, subject });
    } catch (err) {
      logger.error("Email send failed", { err });
    }
  }
}
