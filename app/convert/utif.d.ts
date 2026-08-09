/* UTIF ships no types. Only the one call we make is described — a hand-written
   surface that says what we rely on beats `any`, which would let a rename in
   the library slip past the type checker. */
declare module 'utif' {
  /** Encodes one frame, or several as a multi-page TIFF. */
  export function encodeImage(
    rgba: ArrayBuffer | ArrayBuffer[],
    width: number,
    height: number,
  ): ArrayBuffer;
  const _default: {encodeImage: typeof encodeImage};
  export default _default;
}
