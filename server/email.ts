// Email sending abstraction for account-security messages (password reset). Mirrors sms.ts:
// a safe console provider that never calls out to a real network, ready to be swapped for a
// real SMTP/API provider later without touching any caller.

export interface EmailSendResult {
  ok: boolean;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(toEmail: string, subject: string, body: string): Promise<EmailSendResult>;
}

/** Safe default: never calls any external network — just logs. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  async send(toEmail: string, subject: string, body: string): Promise<EmailSendResult> {
    console.log(`[EMAIL:console] to=${toEmail} subject="${subject}" body="${body}"`);
    return { ok: true };
  }
}

// No hospital has configured a real email provider (SMTP/SendGrid/SES/...) yet — this system
// only ever returns the console provider today. When one is wired up, branch here the same way
// createSmsProvider() branches on the tenant's configured SMS provider.
export function createEmailProvider(): EmailProvider {
  return new ConsoleEmailProvider();
}

/** Composes the password-reset email sent to a staff account. */
export function composePasswordResetEmail(resetUrl: string, language: 'ar' | 'en'): { subject: string; body: string } {
  if (language === 'en') {
    return {
      subject: 'Reset your Tajruba password',
      body: `We received a request to reset your password. This link expires in 30 minutes and can only be used once: ${resetUrl}\nIf you did not request this, you can ignore this email.`
    };
  }
  return {
    subject: 'إعادة تعيين كلمة المرور — تجربة',
    body: `وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بك. هذا الرابط صالح لمدة ٣٠ دقيقة ولمرة واحدة فقط: ${resetUrl}\nإذا لم تطلب ذلك يمكنك تجاهل هذه الرسالة.`
  };
}
