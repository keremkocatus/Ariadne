// Applies the chosen brand mark as the window (title bar / taskbar) icon at runtime,
// so the logo setting changes the whole app, not just the toolbar. The installed
// executable keeps its bundled icon; this only affects the running window.
import { Image as TauriImage } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { findLogo, logoSvg } from "@/components/brand/logos";

const ICON_SIZE = 256;

export async function applyWindowIcon(logoId: string): Promise<void> {
  try {
    const svg = logoSvg(findLogo(logoId), { color: "#ededed", tile: "#141416" });
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
    const { data } = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
    const icon = await TauriImage.new(new Uint8Array(data.buffer), ICON_SIZE, ICON_SIZE);
    await getCurrentWindow().setIcon(icon);
  } catch {
    // Cosmetic only: a platform that refuses a runtime icon keeps the bundled one.
  }
}
