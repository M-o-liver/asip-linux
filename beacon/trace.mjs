const bearer = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const sensitive =
  /^(authorization|proxy-authorization|api[_-]?key|x-api-key|x-goog-api-key|password|access_token|refresh_token|client_secret)$/i;

export function redactTrace(value, credential = "", depth = 0) {
  if (typeof value === "string") {
    const text = credential
      ? value.replaceAll(credential, "[credential]")
      : value;
    return text.replace(bearer, "Bearer [credential]");
  }
  if (depth > 30) return "[nested value]";
  if (Array.isArray(value))
    return value.map((item) => redactTrace(item, credential, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactTrace(key, credential, depth + 1),
        sensitive.test(key)
          ? "[credential]"
          : redactTrace(item, credential, depth + 1),
      ]),
    );
  return value;
}
