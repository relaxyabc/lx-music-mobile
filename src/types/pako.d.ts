declare module 'pako' {
  type Data = Uint8Array | ArrayBuffer | number[] | string

  export function inflateRaw(data: Data): Uint8Array
  export function deflateRaw(data: Data): Uint8Array
  export function inflate(data: Data): Uint8Array
  export function deflate(data: Data): Uint8Array
}
