export type AttachmentProvenance = 'user_upload' | 'agent_generated' | 'system';
export type AttachmentScanStatus = 'pending' | 'sanitized' | 'blocked';
export type AttachmentRiskClass = 'low' | 'sensitive' | 'executable' | 'archive';

export interface SecretRedactionResult {
  text: string;
  redacted: boolean;
  matches: number;
}

const REDACTION = '[REDACTED]';

/**
 * Model-independent last-mile redaction for text crossing a trust boundary.
 * Keep this deliberately conservative: a false positive is preferable to
 * persisting or streaming a credential. Callers must use the returned text.
 */
export function redactSecrets(value: unknown): SecretRedactionResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { text: typeof value === 'string' ? value : '', redacted: false, matches: 0 };
  }

  let text = value;
  let matches = 0;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    text = text.replace(pattern, (...args: string[]) => {
      matches += 1;
      return typeof replacement === 'string' ? replacement : replacement(...args);
    });
  };

  replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, REDACTION);
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTION);
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|[0-9]{6,12}:AA[A-Za-z0-9_-]{20,})\b/g, REDACTION);
  replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, (_all, prefix) => `${prefix}${REDACTION}`);
  replace(/\b(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi, (_all, scheme) => `${scheme}${REDACTION}@`);

  // Covers dotenv, shell assignments, YAML and JSON. It also fails closed on
  // an incomplete streaming value: once a sensitive key and separator appear,
  // the partial value is hidden rather than briefly reaching the client.
  replace(
    /(^|[\s,{])(\"?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|tunnelsecret)\"?\s*[:=]\s*)(["']?)([^\s,}\]\r\n"']*)\3/gim,
    (_all, lead, key) => `${lead}${key}${REDACTION}`,
  );

  return { text, redacted: matches > 0, matches };
}

export function redactSecretText(value: unknown): string {
  return redactSecrets(value).text;
}

export function classifyAttachmentRisk(name: string, mime: string, extractedText?: string): AttachmentRiskClass {
  const lower = name.toLowerCase();
  if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar)$/.test(lower) || mime === 'application/zip') return 'archive';
  if (/(^|\.)(?:env|pem|key|p12|pfx)(?:\.|$)/.test(lower)) return 'sensitive';
  if (/^(?:package(?:-lock)?\.json|dockerfile|makefile|compose\.ya?ml)$/.test(lower)) return 'executable';
  if (/\.(?:js|mjs|cjs|ts|tsx|py|rb|php|sh|bash|zsh|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm)(?:\.|$)/.test(lower)) return 'executable';
  if (extractedText && redactSecrets(extractedText).redacted) return 'sensitive';
  return 'low';
}

/** Only low-risk, redacted document text may enter an agent prompt. */
export function safeAttachmentPromptText(name: string, mime: string, extractedText?: string): string | undefined {
  if (!extractedText) return undefined;
  if (classifyAttachmentRisk(name, mime, extractedText) !== 'low') return undefined;
  return redactSecretText(extractedText);
}

/** Code execution is disabled unless operators deliberately opt in. */
export function isCodeExecutionEnabled(value: unknown): boolean {
  return value === '1';
}
