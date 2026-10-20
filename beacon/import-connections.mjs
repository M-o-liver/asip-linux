import fs from "node:fs";

// A file or private FIFO permits local imports without credentials in argv,
// agent messages, HTTP requests, or an activity record.
export async function importConnections(
  store,
  file,
  { account, timeout = 15000 } = {},
) {
  const owner = account();
  if (!owner) throw new Error("Sign in before importing connections.");
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0),
  );
  let raw;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() && !stat.isFIFO())
      throw new Error("Choose a JSON connection file or a local import pipe.");
    const deadline = Date.now() + timeout,
      chunks = [];
    let size = 0;
    while (true) {
      if (Date.now() >= deadline)
        throw new Error("Connection import timed out.");
      const buffer = Buffer.alloc(16384);
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(buffer));
      } catch (error) {
        if (error.code !== "EAGAIN") throw error;
      }
      if (bytesRead === 0 && (size || stat.isFile())) break;
      if (bytesRead) {
        size += bytesRead;
        if (size > 2 * 1024 * 1024)
          throw new Error("The connection file is too large.");
        chunks.push(buffer.subarray(0, bytesRead));
      } else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
  if (account() !== owner) throw new Error("The ASIP account changed.");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("The connection file is not valid JSON.");
  }
  return store.import(input);
}
