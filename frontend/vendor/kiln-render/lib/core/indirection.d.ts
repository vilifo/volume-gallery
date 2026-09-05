/**
 * Indirection Table - Maps virtual brick coordinates to atlas positions
 * for virtual volume texturing.
 */
import type { DatasetConfig } from './config.js';
export interface BrickLocation {
    virtualX: number;
    virtualY: number;
    virtualZ: number;
    atlasX: number;
    atlasY: number;
    atlasZ: number;
    loaded: boolean;
}
export declare class IndirectionTable {
    private device;
    private data;
    texture: GPUTexture;
    private gridX;
    private gridY;
    private gridZ;
    constructor(device: GPUDevice, config: DatasetConfig);
    /**
     * Register a brick mapping: virtual position -> atlas position.
     * Coarser LODs fill (2^lod)³ cells to cover the equivalent region.
     */
    setBrick(virtualX: number, virtualY: number, virtualZ: number, atlasX: number, atlasY: number, atlasZ: number, lod?: number): void;
    /**
     * Mark a brick region as empty (LOD 255) so coarser LOD data
     * doesn't show through. Unlike clearBrick, this means "loaded but empty".
     */
    setEmpty(virtualX: number, virtualY: number, virtualZ: number, lod?: number): void;
    /**
     * Clear a brick region (mark as not loaded). For coarser LODs, only clears
     * cells still pointing to this LOD. Optional fallback restores parent brick.
     */
    clearBrick(virtualX: number, virtualY: number, virtualZ: number, lod?: number, fallbackAtlas?: [number, number, number], fallbackLod?: number): void;
    /**
     * Clear all mappings
     */
    clearAll(): void;
    /**
     * Update a region of the indirection texture on the GPU
     * Used for multi-cell updates when setting/clearing coarse LOD bricks
     */
    private updateRegionGPU;
    /**
     * Update the full indirection texture on the GPU
     */
    private updateFullGPU;
}
