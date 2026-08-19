// SMS/WhatsApp sending abstraction. Every hospital configures its own provider and
// credentials in Settings (per-tenant, stored in `tenant_integrations`) — nothing here
// reads from process.env, so no redeploy is needed to activate a hospital's account.

export interface SmsSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(toPhone: string, message: string): Promise<SmsSendResult>;
}

/** Safe default: never calls any external network — just logs. Used until a hospital configures a real provider. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  async send(toPhone: string, message: string): Promise<SmsSendResult> {
    console.log(`[SMS:console] to=${toPhone} message="${message}"`);
    return { ok: true, providerMessageId: 'console-noop' };
  }
}

/**
 * Real integration with Unifonic's REST API (common Saudi SMS/WhatsApp provider).
 * Requires a hospital-provided AppSid (API key) and sender name from their own Unifonic
 * account — this code has not been exercised against a live account in this environment
 * (no test credentials available here); verify with a real AppSid before relying on it.
 */
export class UnifonicSmsProvider implements SmsProvider {
  readonly name = 'unifonic';
  private readonly appSid: string;
  private readonly senderName: string;

  constructor(appSid: string, senderName: string) {
    this.appSid = appSid;
    this.senderName = senderName;
  }

  async send(toPhone: string, message: string): Promise<SmsSendResult> {
    try {
      const params = new URLSearchParams({
        AppSid: this.appSid,
        SenderID: this.senderName,
        Recipient: toPhone,
        Body: message
      });
      const response = await fetch('https://el.cloud.unifonic.com/rest/SMS/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = (await response.json().catch(() => null)) as { success?: boolean; data?: { MessageID?: string }; message?: string } | null;
      if (!response.ok || !data?.success) {
        return { ok: false, error: data?.message ?? `HTTP ${response.status}` };
      }
      return { ok: true, providerMessageId: data.data?.MessageID };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'unknown_error' };
    }
  }
}

export interface TenantSmsConfig {
  provider: string;
  apiKey: string | null;
  senderName: string | null;
  defaultLanguage: 'ar' | 'en';
}

export function createSmsProvider(config: TenantSmsConfig): SmsProvider {
  if (config.provider === 'unifonic' && config.apiKey && config.senderName) {
    return new UnifonicSmsProvider(config.apiKey, config.senderName);
  }
  return new ConsoleSmsProvider();
}

/** Composes the invitation SMS text in the tenant's default language. */
export function composeInvitationMessage(templateNameAr: string, templateNameEn: string, surveyUrl: string, language: 'ar' | 'en'): string {
  if (language === 'en') {
    return `${templateNameEn}: please share your feedback — ${surveyUrl}`;
  }
  return `${templateNameAr}: نرجو مشاركتنا رأيك — ${surveyUrl}`;
}

/** Composes the anonymous employee experience/engagement survey invitation SMS. */
export function composeEmployeeSurveyMessage(instrumentNameAr: string, instrumentNameEn: string, surveyUrl: string, language: 'ar' | 'en'): string {
  if (language === 'en') {
    return `${instrumentNameEn}: your response is fully anonymous — ${surveyUrl}`;
  }
  return `${instrumentNameAr}: إجابتك مجهولة تمامًا — ${surveyUrl}`;
}

/** Composes the closed-loop notification sent once a patient's service recovery case is resolved. */
export function composeResolutionMessage(hospitalNameAr: string, hospitalNameEn: string, language: 'ar' | 'en'): string {
  if (language === 'en') {
    return `${hospitalNameEn}: thank you for your feedback. We have addressed your concern — we appreciate you helping us improve.`;
  }
  return `${hospitalNameAr}: شكرًا لتواصلك معنا، تم النظر في ملاحظتك ومعالجتها. نقدّر مساهمتك في تحسين الخدمة.`;
}

/** Composes the PROMs follow-up SMS sent when a scheduled assignment is due. */
export function composePromsMessage(
  instrumentNameAr: string,
  instrumentNameEn: string,
  timepointNameAr: string,
  formUrl: string,
  optOutUrl: string,
  language: 'ar' | 'en'
): string {
  if (language === 'en') {
    return `Please complete "${instrumentNameEn}" (${timepointNameAr}) so we can track your recovery — ${formUrl}\nTo stop these messages: ${optOutUrl}`;
  }
  return `نرجو تعبئة "${instrumentNameAr}" (${timepointNameAr}) لمتابعة حالتك الصحية — ${formUrl}\nلإيقاف هذه الرسائل: ${optOutUrl}`;
}

/** Composes a one-time reminder for a PROMs assignment that was sent but never completed. */
export function composePromsReminderMessage(
  instrumentNameAr: string,
  instrumentNameEn: string,
  formUrl: string,
  optOutUrl: string,
  language: 'ar' | 'en'
): string {
  if (language === 'en') {
    return `Reminder: please complete "${instrumentNameEn}" — ${formUrl}\nTo stop these messages: ${optOutUrl}`;
  }
  return `تذكير: نرجو تعبئة "${instrumentNameAr}" — ${formUrl}\nلإيقاف هذه الرسائل: ${optOutUrl}`;
}
