/**
 * Volume canvas (atlas) and test volume generation
 */
import type { BitDepth, BrickData } from '../data/data-provider.js';
export interface VolumeCanvas {
    texture: GPUTexture;
    size: number;
    bitDepth: BitDepth;
    format: GPUTextureFormat;
}
/**
 * Detect best supported texture format for 16-bit data.
 * Tries r16float first (filterable), falls back to r8unorm.
 */
export declare function detectBest16BitFormat(device: GPUDevice): GPUTextureFormat;
/** Create empty volume canvas (atlas texture). Size defaults to the full ATLAS_SIZE. */
export declare function createVolumeCanvas(device: GPUDevice, bitDepth: BitDepth, format: GPUTextureFormat, atlasSize?: number): VolumeCanvas;
/**
 * Write volume data into canvas at specified offset
 * Handles both 8-bit and 16-bit data based on canvas bitDepth
 */
export declare function writeToCanvas(device: GPUDevice, canvas: VolumeCanvas, data: BrickData, size: [number, number, number], offset?: [number, number, number]): void;
/**
 * Generate test volume data with centered sphere
 */
export declare function generateSphereVolume(size: number, radius: number, intensity: number): Uint8Array;
/**
 * Generate solid volume with uniform intensity
 */
export declare function generateSolidVolume(size: [number, number, number], intensity: number): Uint8Array;
