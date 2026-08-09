/* libheif ships no types. Only the two calls we make are described here —
   a hand-written surface that says exactly what we rely on beats `any`, which
   would let a rename in the library slip through the type checker. */
declare module 'libheif-js/wasm-bundle' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(data: ImageData, cb: (out: ImageData | null) => void): void;
  }
  export class HeifDecoder {
    decode(bytes: Uint8Array): HeifImage[];
  }
  const _default: {HeifDecoder: typeof HeifDecoder};
  export default _default;
}
