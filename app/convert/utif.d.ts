/* UTIF ships no types. Only the one call we make is described — a hand-written
   surface that says what we rely on beats `any`, which would let a rename in
   the library slip past the type checker. */
declare module 'utif' {
  /** One image file directory — a page, with its size once decoded. */
  export interface IFD {
    width: number;
    height: number;
    data?: Uint8Array;
    [tag: string]: unknown;
  }
  /** Encodes one frame, or several as a multi-page TIFF. */
  export function encodeImage(
    rgba: ArrayBuffer | ArrayBuffer[],
    width: number,
    height: number,
  ): ArrayBuffer;
  /** Splits a TIFF into its pages without decoding the pixels. */
  export function decode(buffer: ArrayBuffer | Uint8Array): IFD[];
  /** Decodes one page's pixels into `ifd.data`, in the file's own layout. */
  export function decodeImage(
    buffer: ArrayBuffer | Uint8Array,
    ifd: IFD,
    ifds?: IFD[],
  ): void;
  /** That layout, whatever it was, as straight RGBA. */
  export function toRGBA8(ifd: IFD): Uint8Array;
  const _default: {
    encodeImage: typeof encodeImage;
    decode: typeof decode;
    decodeImage: typeof decodeImage;
    toRGBA8: typeof toRGBA8;
  };
  export default _default;
}
