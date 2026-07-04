// Auto-update: tauri.conf.json's plugins.updater.endpoints points at the GitHub
// Releases `latest.json` the release workflow publishes. check() verifies the
// manifest's signature against the embedded pubkey before ever reporting an update.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

let startupChecked = false;

async function installAndRelaunch(update: Update): Promise<void> {
  const id = "app-update-installing";
  toast.loading(`Installing update ${update.version}…`, { id });
  try {
    await update.downloadAndInstall();
    toast.success("Update installed — restarting…", { id });
    await relaunch();
  } catch (e) {
    toast.error("Update failed to install", { id, description: String(e) });
  }
}

async function runCheck(reportIfNone: boolean): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (reportIfNone) toast("You're up to date");
      return;
    }
    toast(`Update available: ${update.version}`, {
      id: "app-update-available",
      description: update.body || "A new version of Ariadne is ready to install.",
      duration: 60_000,
      closeButton: true,
      action: { label: "Install & restart", onClick: () => void installAndRelaunch(update) },
    });
  } catch (e) {
    if (reportIfNone) toast.error("Couldn't check for updates", { description: String(e) });
  }
}

/// Called once at App mount. Silent when there's no update or the check fails
/// (e.g. offline) — startup should never nag.
export function checkForUpdateOnStartup(): void {
  if (startupChecked) return;
  startupChecked = true;
  void runCheck(false);
}

/// The Settings "Check for updates" button — always reports back, including
/// "you're up to date" and errors, since the user explicitly asked.
export function checkForUpdateManually(): void {
  void runCheck(true);
}
