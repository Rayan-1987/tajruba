import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleBasedAnalyzer, redactPii, shouldAlert } from '../server/comments.ts';

test('redactPii masks Saudi mobile numbers', () => {
  const redacted = redactPii('تواصلوا معي على 0512345678 بأسرع وقت');
  assert.ok(!redacted.includes('0512345678'));
  assert.ok(redacted.includes('[رقم'));
});

test('redactPii masks MRN and email references', () => {
  const redacted = redactPii('رقم ملفي MRN-123456 وبريدي test@example.com');
  assert.ok(!redacted.includes('123456'));
  assert.ok(!redacted.includes('test@example.com'));
});

test('redactPii masks national id-like 10 digit numbers', () => {
  const redacted = redactPii('هويتي الوطنية 1023456789 للتأكيد');
  assert.ok(!redacted.includes('1023456789'));
});

test('RuleBasedAnalyzer flags critical safety language with max severity', () => {
  const analyzer = new RuleBasedAnalyzer();
  const result = analyzer.analyze('أشعر بألم شديد بالصدر منذ الخروج ولم يتابع معي أحد');
  assert.equal(result.severity, 5);
  assert.equal(shouldAlert(result.severity), true);
});

test('RuleBasedAnalyzer categorizes nursing feedback and detects positive sentiment', () => {
  const analyzer = new RuleBasedAnalyzer();
  const result = analyzer.analyze('الممرضات كانوا متعاونين وممتازين، شكرا لكم');
  assert.equal(result.category, 'nursing');
  assert.equal(result.sentiment, 'positive');
  assert.equal(shouldAlert(result.severity), false);
});

test('RuleBasedAnalyzer detects negative sentiment for long waits', () => {
  const analyzer = new RuleBasedAnalyzer();
  const result = analyzer.analyze('انتظرت وقت طويل جدا والخدمة كانت بطيئة وسيئة');
  assert.equal(result.category, 'waiting_time');
  assert.equal(result.sentiment, 'negative');
});
