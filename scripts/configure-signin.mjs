import fs from "node:fs";

const value = process.env.ASIP_GOOGLE_DESKTOP_CLIENT_JSON;
if (value) {
  const client = JSON.parse(value).installed;
  const config = JSON.parse(fs.readFileSync("beacon/signin.json", "utf8"));
  if (!client?.client_secret || client.client_id !== config.googleClientId)
    throw new Error(
      "Google desktop client does not match the registered ASIP client.",
    );
  fs.writeFileSync(
    "beacon/google-client.json",
    JSON.stringify({
      installed: {
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    }),
    { mode: 0o600 },
  );
}
