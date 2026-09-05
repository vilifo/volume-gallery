/**
 * Histogram computation utilities for volume data analysis
 */
import type { BitDepth } from '../data/data-provider.js';
/**
 * Compute a histogram from volume data arrays. Handles uint8/uint16 directly,
 * float32-as-r16float (with range remapping), and uint16-as-r16float.
 */
export declare function computeHistogram(dataArrays: (Uint8Array | Uint16Array)[], bitDepth: BitDepth, bins?: number, isFloat32?: boolean, floatMin?: number, floatMax?: number, targetFormat?: GPUTextureFormat): Uint32Array;
