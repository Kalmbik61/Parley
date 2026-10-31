// `qrcode` ships no types; main needs only `toDataURL` (pairing QR, mobile plan A10).
declare module 'qrcode' {
  export function toDataURL(text: string, options?: { margin?: number; width?: number }): Promise<string>;
}
