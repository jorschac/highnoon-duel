declare module 'fengari' {
  // Fengari's C-API-shaped package has no bundled TS declarations. Dynamic
  // stack operations are isolated to authority.ts; game/domain APIs stay typed.
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(value: string): Uint8Array;
  export function to_jsstring(value: Uint8Array): string;
}
