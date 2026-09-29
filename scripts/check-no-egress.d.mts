export interface ScannedFile { path: string; text: string }
export const EGRESS_RULES: Array<[string, RegExp]>;
export const REQUIRED_PERMISSIONS: string[];
export function scanForEgress(files: ScannedFile[]): string[];
export function checkManifest(manifest: Record<string, unknown>): string[];
export function collectSourceFiles(): ScannedFile[];
export function collectDistFiles(): ScannedFile[] | null;
