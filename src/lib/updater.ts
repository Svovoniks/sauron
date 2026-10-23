import { Channel, invoke } from "@tauri-apps/api/core";

/** A newer release found on GitHub. */
export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

type InstallEvent = { event: "progress"; data: { downloaded: number; total: number | null } } | { event: "installing" };

/** Asks GitHub for a newer release; null when this is the latest. Rejects when offline / the release is unsigned. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    return await invoke<UpdateInfo | null>("check_for_update");
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Downloads and installs the update found by the last `checkForUpdate`. `onProgress` gets 0..1, or null when the size is unknown. */
export async function installUpdate(onProgress: (fraction: number | null) => void, onInstalling: () => void): Promise<void> {
  const events = new Channel<InstallEvent>();
  events.onmessage = (message) => {
    if (message.event === "progress") onProgress(message.data.total ? Math.min(1, message.data.downloaded / message.data.total) : null);
    else onInstalling();
  };
  try {
    await invoke("install_update", { events });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export const restartApp = () => invoke<void>("restart_app");

/** "1.2.3" > "1.2.0"? (only used to decide whether a skipped version is still the offered one) */
export const sameVersion = (a: string, b: string) => a.replace(/^v/, "") === b.replace(/^v/, "");
