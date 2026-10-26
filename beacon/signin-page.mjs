export function signInPage(title, detail) {
  const escape = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — ASIP</title><style>:root{font:16px/1.65 system-ui,sans-serif;color:#182f2b;background:#f6f7f2}body{margin:0;padding:8vh 24px}main{max-width:560px;margin:auto}header{font-size:25px;font-weight:750;letter-spacing:-1px}section{background:white;border:1px solid #d9e0d7;border-radius:18px;padding:32px;margin-top:32px}h1{font-size:32px;line-height:1.15;letter-spacing:-1px}p{color:#52655e}a{display:inline-block;background:#22634f;color:white;border-radius:8px;padding:12px 20px;text-decoration:none}a:focus-visible{outline:3px solid #9b6a28;outline-offset:4px}</style><main><header>ASIP <small>Beacon</small></header><section><h1>${escape(title)}</h1><p>${escape(detail)}</p><a href="https://asip.ca/app">Open your workspace ↗</a></section></main></html>`;
}
export function sendSignInPage(response, status, title, detail) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(signInPage(title, detail));
}
