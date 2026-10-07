export const DEFAULT_MASSED_ORIGIN = "https://vm.massedcompute.com";
export const MASSED_BASE = `${DEFAULT_MASSED_ORIGIN}/api/v1`;
export const USER_AGENT = "MassComputeManagementUI/1.0";

/** Massed's origin. Override with the MASSED_ORIGIN var only to point at a test double. */
export function massedOrigin(env: Env): string {
  return ((env as { MASSED_ORIGIN?: string }).MASSED_ORIGIN || DEFAULT_MASSED_ORIGIN).replace(/\/+$/, "");
}
