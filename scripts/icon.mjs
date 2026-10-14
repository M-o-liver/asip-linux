import fs from "node:fs";
import zlib from "node:zlib";

// A simple connected-node mark. Generate the raster needed by native trays.
const size = 512,
  pixels = Buffer.alloc(size * (size * 4 + 1));
const nodes = [
  [160, 156],
  [352, 156],
  [256, 352],
];
function distance(x, y, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const ink =
      nodes.some((n) => Math.hypot(x - n[0], y - n[1]) < 44) ||
      nodes.some((n, i) => distance(x, y, n, nodes[(i + 1) % 3]) < 12);
    const radius = Math.hypot(
      Math.max(0, Math.abs(x - 256) - 172),
      Math.max(0, Math.abs(y - 256) - 172),
    );
    const color = ink
      ? [255, 255, 255, 255]
      : radius < 76
        ? [38, 67, 137, 255]
        : [0, 0, 0, 0];
    color.forEach((c, i) => (pixels[offset + i] = c));
  }
function crc(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type),
    size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([tag, data])));
  return Buffer.concat([size, tag, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
fs.writeFileSync(
  new URL("../beacon/icon.png", import.meta.url),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
