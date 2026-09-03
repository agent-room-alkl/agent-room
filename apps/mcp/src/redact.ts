/**
 * A URL that reaches an error message or a log line must not carry a
 * capability. Legacy self-hosted attachment URLs embed the room token as
 * ?access=, and a base URL can carry userinfo, so every interpolated URL is
 * reduced to origin + path first. The path and status stay, so the error
 * still says what failed where.
 */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return input.split(/[?#]/, 1)[0] ?? '';
  }
}
