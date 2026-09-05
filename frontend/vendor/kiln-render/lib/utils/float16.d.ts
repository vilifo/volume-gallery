/**
 * Float16 conversion utilities — converts uint16 intensity values (0-65535)
 * to IEEE 754 half-precision for WebGPU's r16float texture format.
 */
export declare function float32ToFloat16Bits(f32: number): number;
/** Decode a uint16 float16 bit pattern to a JavaScript number. */
export declare function float16BitsToFloat32(bits: number): number;
/** Lazily-built LUT mapping a raw uint16 intensity directly to its float16 bit pattern. */
export declare function getUint16ToFloat16Lut(): Uint16Array;
/** Lazily-built LUT mapping every float16 bit pattern to its decoded float32 value. */
export declare function getFloat16ToFloat32Lut(): Float32Array;
/** Convert a Uint16Array (0-65535) to float16 binary format for r16float textures. */
export declare function uint16ToFloat16(uint16Data: Uint16Array): Uint16Array;
