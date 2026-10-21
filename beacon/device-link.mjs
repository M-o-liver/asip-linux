// An ephemeral device key keeps the preview assertion out of callback URLs.
// Only the Beacon that started this connection can open the browser reply.
const encoder = new TextEncoder();
const context = (challenge, state) =>
  encoder.encode("ASIP device link v1:" + challenge + ":" + state);
function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
function bytes(value) {
  if (!/^04[a-f0-9]{128}$/.test(value || ""))
    throw Error("Invalid device public key.");
  return Uint8Array.from(value.match(/../g), (n) => parseInt(n, 16));
}
function encode(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || "") || value.length > 24000)
    throw Error("Invalid device reply.");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(privateKey, publicKey, challenge, state) {
  const peer = await crypto.subtle.importKey(
    "raw",
    bytes(publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peer },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(challenge),
      info: context(challenge, state),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function deviceKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: hex(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}
export async function sealDeviceReply(value, publicKey, challenge, state) {
  const pair = await deviceKey(),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context(challenge, state) },
      await key(pair.privateKey, publicKey, challenge, state),
      encoder.encode(JSON.stringify(value)),
    );
  return encode(
    encoder.encode(
      JSON.stringify({
        v: 1,
        key: pair.publicKey,
        iv: encode(iv),
        data: encode(encrypted),
      }),
    ),
  );
}
export async function openDeviceReply(reply, privateKey, challenge, state) {
  const sealed = JSON.parse(new TextDecoder().decode(decode(reply)));
  if (sealed.v !== 1) throw Error("Unsupported device reply.");
  const iv = decode(sealed.iv);
  if (iv.length !== 12) throw Error("Invalid device reply.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: context(challenge, state) },
    await key(privateKey, sealed.key, challenge, state),
    decode(sealed.data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
