export interface ScannedFile { path: string; text: string }
export const SCHEMA_ALLOWLIST: Record<string, string[]>;
export const URL_MODULE: string;
export const UI_DIR: string;
export const TIER2_TOKENS: string[];
export function interfaceFields(src: string, name: string): string[] | null;
export function checkSchema(typesSrc: string): string[];
export function checkTokens(files: ScannedFile[]): string[];
export const CREDENTIAL_CASE_RE: RegExp;
