// Position a tray panel within its display, including top/side taskbars and
// displays whose coordinates are negative. A missing tray uses the full app.
function panelBounds(tray, area, width = 460, height = 500) {
  if (!tray || !tray.width || !tray.height) return null;
  width = Math.min(width, area.width - 16);
  height = Math.min(height, area.height - 16);
  const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
  const below = tray.y + tray.height + 8;
  return {
    width,
    height,
    x: Math.round(
      clamp(
        tray.x + tray.width / 2 - width / 2,
        area.x + 8,
        area.x + area.width - width - 8,
      ),
    ),
    y: Math.round(
      clamp(
        below + height <= area.y + area.height ? below : tray.y - height - 8,
        area.y + 8,
        area.y + area.height - height - 8,
      ),
    ),
  };
}
module.exports = { panelBounds };
