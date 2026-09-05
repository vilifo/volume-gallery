/**
 * VolumeResources — atlas textures, indirection table, and slot allocator.
 * Shared between Renderer and StreamingManager.
 */
import { VolumeCanvas } from './volume.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator } from '../streaming/atlas-allocator.js';
import type { DatasetConfig } from './config.js';
import type { BitDepth } from '../data/data-provider.js';
export declare class VolumeResources {
    readonly numChannels: number;
    /** Atlas grid dimension (slots per axis) — may be shrunk to fit a VRAM budget */
    readonly gridSize: number;
    /** Atlas texture dimension in voxels (gridSize × PHYSICAL_BRICK_SIZE) */
    readonly atlasSize: number;
    /** Per-channel atlas textures (length === numChannels) */
    readonly canvases: VolumeCanvas[];
    /** Indirection table for virtual texturing */
    readonly indirection: IndirectionTable;
    /** Atlas slot allocator (LRU with thrash guard) */
    readonly allocator: AtlasAllocator;
    /** 1×1×1 dummy texture bound to unused channel slots */
    private readonly dummyTexture;
    /** Channel-0 alias for single-channel callers */
    get canvas(): VolumeCanvas;
    constructor(device: GPUDevice, bitDepth: BitDepth, textureFormat: GPUTextureFormat, config: DatasetConfig, numChannels?: number, gridSize?: number);
    /** View for atlas channel ch (dummy if ch >= numChannels) */
    atlasView(ch: number): GPUTextureView;
}
