/**
 * A byte array backed by a plain (non-shared) ArrayBuffer.
 *
 * WebUSB's transfer methods only accept these, and a bare `Uint8Array` is
 * `Uint8Array<ArrayBufferLike>`, wide enough to include SharedArrayBuffer, so
 * TypeScript rejects it at the USB boundary. Using this alias throughout the
 * transfer paths keeps `subarray()` results assignable without casting.
 */
export type Bytes = Uint8Array<ArrayBuffer>;
