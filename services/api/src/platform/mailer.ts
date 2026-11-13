/**
 * Email delivery for subscriptions and alerts. SMTP via nodemailer (works with Amazon SES's SMTP
 * endpoint or any SMTP relay). With no SMTP_URL, there is no mailer: features record runs as
 * "email not configured" instead of failing.
 */

export interface MailAttachment {
  filename: string;
  /** Text (CSV) or bytes (the PDF report). */
  content: string | Uint8Array;
  contentType: string;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const EMAIL_PATTERN = /^[^\s@<>,;"']{1,64}@[^\s@<>,;"']{1,253}\.[A-Za-z]{2,}$/;

export class SmtpMailer implements Mailer {
  private transport?: Promise<{ sendMail(m: Record<string, unknown>): Promise<unknown> }>;

  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}

  private get transporter() {
    this.transport ??= import('nodemailer').then((m) => m.default.createTransport(this.url) as never);
    return this.transport;
  }

  async send(message: MailMessage): Promise<void> {
    const t = await this.transporter;
    await t.sendMail({
      from: this.from,
      to: message.to.join(', '),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
  }
}

/** Escapes text for the HTML part of an email. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
