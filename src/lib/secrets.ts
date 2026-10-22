import { invoke } from "@tauri-apps/api/core";

/** Passwords live in the OS keychain, keyed by connection id. They never touch app storage. */

export const savePassword = (connectionId: string, password: string) =>
  invoke<void>("save_password", { connectionId, password });

export const deletePassword = (connectionId: string) => invoke<void>("delete_password", { connectionId });

export const hasPassword = (connectionId: string) => invoke<boolean>("has_password", { connectionId });

/** The password itself, or null when none is saved. */
export const getPassword = (connectionId: string) => invoke<string | null>("get_password", { connectionId });
