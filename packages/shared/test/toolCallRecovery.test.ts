import { describe, it, expect } from 'vitest';
import { recoverLeakedRunCode, looksLikeLeakedToolCall } from '../src/toolCallRecovery.js';

describe('recoverLeakedRunCode', () => {
  it('recovers the real DeepSeek DSML tag-form leak (the reported sample)', () => {
    const leaked = [
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="run_code">',
      '<｜｜DSML｜｜parameter name="code" string="true">import os; print(os.getcwd()); print(os.listdir(\'.\'))</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="language" string="true">python</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join('\n');

    const { calls, cleaned } = recoverLeakedRunCode(leaked);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.language).toBe('python');
    expect(calls[0]!.code).toBe("import os; print(os.getcwd()); print(os.listdir('.'))");
    // The whole message WAS the leaked call → nothing left to surface as chat.
    expect(cleaned).toBe('');
  });

  it('keeps surrounding prose and strips only the leaked block', () => {
    const leaked = [
      'Let me verify the directory first.',
      '<｜｜DSML｜｜invoke name="run_code">',
      '<｜｜DSML｜｜parameter name="language" string="true">bash</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="code" string="true">ls -la</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
    ].join('\n');

    const { calls, cleaned } = recoverLeakedRunCode(leaked);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.language).toBe('bash');
    expect(calls[0]!.code).toBe('ls -la');
    expect(cleaned).toBe('Let me verify the directory first.');
  });

  it('defaults language to python when the parameter is absent', () => {
    const leaked =
      '<invoke name="run_code"><parameter name="code">print(42)</parameter></invoke>';
    const { calls } = recoverLeakedRunCode(leaked);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.language).toBe('python');
    expect(calls[0]!.code).toBe('print(42)');
  });

  it('recovers the JSON / fenced-args form (DeepSeek native tokens)', () => {
    const leaked =
      'run_code\n```json\n{"language":"javascript","code":"console.log(1)"}\n```';
    const { calls } = recoverLeakedRunCode(leaked);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.language).toBe('javascript');
    expect(calls[0]!.code).toBe('console.log(1)');
  });

  it('carries through optional flags (expose_port / background / deliver_path)', () => {
    const leaked = [
      '<｜｜DSML｜｜invoke name="run_code">',
      '<｜｜DSML｜｜parameter name="language" string="true">python</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="code" string="true">app.run()</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="expose_port" string="true">8000</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
    ].join('\n');
    const { calls } = recoverLeakedRunCode(leaked);
    expect(calls[0]!.expose_port).toBe(8000);
  });

  it('recovers multiple leaked calls in document order', () => {
    const leaked = [
      '<invoke name="run_code"><parameter name="language">python</parameter><parameter name="code">print("a")</parameter></invoke>',
      '<invoke name="run_code"><parameter name="language">python</parameter><parameter name="code">print("b")</parameter></invoke>',
    ].join('\n');
    const { calls } = recoverLeakedRunCode(leaked);
    expect(calls.map(c => c.code)).toEqual(['print("a")', 'print("b")']);
  });

  it('returns nothing for ordinary prose (no false positives)', () => {
    const text = 'I ran the code and it printed the working directory. All good.';
    const { calls, cleaned } = recoverLeakedRunCode(text);
    expect(calls).toHaveLength(0);
    expect(cleaned).toBe(text);
  });

  it('ignores a leaked block with an empty code body', () => {
    const leaked =
      '<invoke name="run_code"><parameter name="language">python</parameter><parameter name="code">   </parameter></invoke>';
    const { calls } = recoverLeakedRunCode(leaked);
    expect(calls).toHaveLength(0);
  });

  it('leaves text mentioning run_code in passing untouched', () => {
    const text = 'You can use the run_code tool to execute snippets.';
    expect(looksLikeLeakedToolCall(text)).toBe(true); // marker present...
    const { calls } = recoverLeakedRunCode(text);   // ...but nothing parseable
    expect(calls).toHaveLength(0);
  });
});
