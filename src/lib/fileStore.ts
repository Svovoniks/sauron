import { invoke } from "@tauri-apps/api/core";

/** Small JSON files next to the main data (see storage.rs). A file that cannot be parsed is moved aside, never overwritten. */
export async function readJsonFile(name: string): Promise<unknown | null> {
  const text = await invoke<string | null>("storage_read", { name });
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    await invoke("storage_quarantine", { name }).catch(() => undefined);
    return null;
  }
}

export const writeFileText = (name: string, content: string) => invoke<void>("storage_write", { name, content });
