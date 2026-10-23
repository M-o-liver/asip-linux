import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

// Manifests belong at the ZIP root, including hidden manifest directories.
// Preserve executable permissions for harnesses that extract on Unix.
export function writePluginArchive(
  directory,
  destination = directory + ".zip",
) {
  const files = Object.create(null);
  function visit(folder, prefix = "") {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(source, name + "/");
      else if (entry.isFile())
        files[name] = [
          fs.readFileSync(source),
          {
            os: 3,
            attrs: (fs.statSync(source).mode & 0xffff) << 16,
            mtime: new Date(1980, 0, 1),
          },
        ];
      else throw new Error("Plugin archives must contain regular files only.");
    }
  }
  visit(directory);
  const archive = Buffer.from(zipSync(files, { level: 6 }));
  if (
    fs.existsSync(destination) &&
    fs.readFileSync(destination).equals(archive)
  )
    return destination;
  const temporary = destination + ".new";
  try {
    fs.writeFileSync(temporary, archive);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}
