import { describe, expect, it } from 'vitest';
import {
  classifyAttachmentRisk,
  isCodeExecutionEnabled,
  redactSecrets,
  safeAttachmentPromptText,
} from './security.js';

describe('secret redaction', () => {
  it('redacts canary credentials without reproducing them', () => {
    const canary = ['API_KEY=' + 'sk-' + 'A'.repeat(24), 'Authorization: Bearer canary-value-123'].join('\n');
    const result = redactSecrets(canary);
    expect(result.redacted).toBe(true);
    expect(result.matches).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain('[REDACTED]');
    expect(result.text).not.toContain('canary-value-123');
    expect(result.text).not.toContain('sk-' + 'A'.repeat(24));
  });

  it('redacts private-key blocks and secret JSON fields', () => {
    const input = '-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----\n{"TunnelSecret":"not-a-real-secret"}';
    const result = redactSecrets(input);
    expect(result.text).not.toContain('canary');
    expect(result.text).not.toContain('not-a-real-secret');
  });
});

describe('attachment prompt projection', () => {
  it('blocks the 5YJ double-extension script and dotenv config', () => {
    expect(classifyAttachmentRisk('index.js.txt', 'text/plain')).toBe('executable');
    expect(classifyAttachmentRisk('package.json', 'application/json')).toBe('executable');
    expect(classifyAttachmentRisk('.env.txt', 'text/plain')).toBe('sensitive');
    expect(safeAttachmentPromptText('index.js.txt', 'text/plain', 'spawn("node")')).toBeUndefined();
    expect(safeAttachmentPromptText('.env.txt', 'text/plain', 'TOKEN=canary')).toBeUndefined();
  });

  it('allows ordinary documents after redaction', () => {
    expect(safeAttachmentPromptText('notes.md', 'text/markdown', 'hello world')).toBe('hello world');
  });
});

describe('execution kill switch', () => {
  it('is fail-closed and only accepts the explicit value 1', () => {
    expect(isCodeExecutionEnabled(undefined)).toBe(false);
    expect(isCodeExecutionEnabled('true')).toBe(false);
    expect(isCodeExecutionEnabled('0')).toBe(false);
    expect(isCodeExecutionEnabled('1')).toBe(true);
  });
});
