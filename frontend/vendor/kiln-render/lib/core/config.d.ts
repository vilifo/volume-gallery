/** Kiln Configuration — volume rendering and virtual texturing constants. */
export declare const LOGICAL_BRICK_SIZE = 64;
export declare const PHYSICAL_BRICK_SIZE = 66;
export declare const ATLAS_SIZE = 660;
export declare const MAX_BRICK_TRAVERSALS = 512;
export declare const GRID_SIZE: number;
export declare const TOTAL_BRICK_SLOTS: number;
export declare const BRICK_SIZE = 64;
export declare const DEFAULT_ATLAS_BUDGET_BYTES = 1400000000;
export declare const MIN_GRID_SIZE = 6;
/**
 * Largest atlas grid (slots/axis) whose VRAM (numChannels × atlasSize³ ×
 * bytesPerVoxel) fits budgetBytes, clamped to [MIN_GRID_SIZE, GRID_SIZE].
 */
export declare function computeAtlasGrid(numChannels: number, bytesPerVoxel: number, budgetBytes?: number): {
    gridSize: number;
    atlasSize: number;
};
export declare const CONFIG: {
    readonly LOGICAL_BRICK_SIZE: 64;
    readonly PHYSICAL_BRICK_SIZE: 66;
    readonly BRICK_SIZE: 64;
    readonly ATLAS_SIZE: 660;
    readonly GRID_SIZE: number;
    readonly TOTAL_BRICK_SLOTS: number;
    readonly MAX_BRICK_TRAVERSALS: 512;
};
/**
 * Immutable value object describing dataset geometry.
 * Computed from VolumeMetadata and injected into subsystems at construction.
 */
export declare class DatasetConfig {
    readonly dimensions: [number, number, number];
    readonly voxelSpacing: [number, number, number];
    /** Bricks per axis at LOD 0 */
    readonly datasetGrid: [number, number, number];
    /** Normalized extent [0–1] per axis, accounting for anisotropic voxel spacing */
    readonly normalizedSize: [number, number, number];
    /** Bricks with max intensity below this value are considered empty */
    readonly emptyBrickThreshold: number;
    constructor(dimensions: [number, number, number], voxelSpacing?: [number, number, number], emptyBrickThreshold?: number);
}
