import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Runtime } from "../beacon/runtime.mjs";
import { Recovery } from "../beacon/recovery.mjs";
import { importHistory } from "../beacon/import-history.mjs";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "account-directory": { type: "string" },
  },
});
if (!values.source || !values["account-directory"])
  throw new Error(
    "Pass --source and --account-directory for an existing signed-in Beacon account.",
  );
const directory = path.resolve(values["account-directory"]);
const accountId = path.basename(directory);
if (
  !/^[a-f0-9]{64}$/.test(accountId) ||
  path.basename(path.dirname(directory)) !== "accounts" ||
  !fs.existsSync(path.join(directory, "activity.sqlite"))
)
  throw new Error("Choose an existing Beacon account directory.");
const runtime = new Runtime(path.dirname(path.dirname(directory)));
runtime.signIn({ accountId });
try {
  const recovery = new Recovery(runtime);
  console.log(
    JSON.stringify(
      importHistory(runtime, path.resolve(values.source), {
        checkpoint: () => recovery.save("Before history import"),
      }),
    ),
  );
} finally {
  await runtime.close();
}
