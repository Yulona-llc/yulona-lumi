import nodemailer from "nodemailer";
import type { EmailMessage, EmailProvider } from "./types";

export interface SmtpOptions {
  host: string;
  port?: number;
  user?: string;
  pass?: string;
  secure?: boolean;
  from: string;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transport;
  constructor(private readonly o: SmtpOptions) {
    this.transport = nodemailer.createTransport({
      host: o.host,
      port: o.port ?? (o.secure ? 465 : 587),
      secure: o.secure ?? false,
      requireTLS: !o.secure && !!o.user,
      auth: o.user ? { user: o.user, pass: o.pass } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  async send(msg: EmailMessage) {
    const r = await this.transport.sendMail({
      from: msg.from ?? this.o.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo,
    });
    return { id: String(r.messageId) };
  }
}
