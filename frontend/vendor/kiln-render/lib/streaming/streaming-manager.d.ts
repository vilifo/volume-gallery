/**
 * StreamingManager - Resident set manager for brick streaming. Selects visible
 * bricks by frustum/LOD, queues priority loads, and cancels stale requests.
 */
import { Camera } from '../core/camera.js';
import type { VolumeResources } from '../core/volume-resources.js';
import type { DataProvider, VolumeMetadata } from '../data/data-provider.js';
import { AtlasSlot } from './atlas-allocator.js';
import type { DatasetConfig } from '../core/config.js';
import type { PipelineTimings } from '../data/data-provider.js';
export interface BrickRequest {
    lod: number;
    bx: number;
    by: number;
    bz: number;
    distance: number;
    key: string;
}
export interface LoadedBrickInfo {
    slot: AtlasSlot;
    slotIndex: number;
}
export interface StreamingStats {
    desiredCount: number;
    loadedCount: number;
    pendingCount: number;
    cancelledCount: number;
    atlasUsage: number;
    atlasCapacity: number;
    totalBytesDownloaded: number;
    bytesPerSecond: number;
    requestCount: number;
    timeToFirstRender: number | null;
    evictedCount: number;
    allocationsRefused: number;
    pipelineTimings: PipelineTimings;
    bricksDispatched: number;
    bricksCommitted: number;
    bricksCancelled: number;
    bricksDiscarded: number;
    avgBrickLatencyMs: number;
}
export declare class StreamingManager {
    private resources;
    private onResetAccumulation;
    private dataProvider;
    private metadata;
    private device;
    private config;
    private loadedBricks;
    private pinnedBricks;
    private emptyBricks;
    private brickCache;
    baseLodLoaded: boolean;
    private loadStartTime;
    timeToFirstRender: number | null;
    private desiredKeys;
    private loadQueue;
    private inFlightRequests;
    private inFlightStaleTime;
    private readonly CANCEL_GRACE_MS;
    private maxConcurrentRequests;
    private onBaseLodLoaded;
    private onRangesDerived;
    private baseLodPending;
    private frameCount;
    private resetAccumulationTimer;
    private uploadAvg;
    private bricksDispatched;
    private bricksCommitted;
    private bricksCancelled;
    private bricksDiscarded;
    private brickLatencyAvg;
    private dispatchTimestamps;
    maxPixelError: number;
    private readonly cameraFovRad;
    private projectionFactor;
    private maxDesiredBricks;
    private allocationStalled;
    private zeroBricks;
    private lastStats;
    private lastUpdateFrame;
    private updateInterval;
    private lastCameraPos;
    private cameraStillFrames;
    private cameraMovementThreshold;
    private cameraStillThreshold;
    private readonly maxLod;
    private readonly levelsByLod;
    constructor(resources: VolumeResources, dataProvider: DataProvider, metadata: VolumeMetadata, device: GPUDevice, config: DatasetConfig, onResetAccumulation: () => void, pageLoadStartTime?: number);
    /** Set callback to be invoked when base LOD is loaded with brick data */
    setBaseLodLoadedCallback(callback: (brickData: (Uint8Array | Uint16Array)[]) => void): void;
    /** Set callback for when base LOD derives float/channel ranges */
    setRangesDerivedCallback(callback: (opts: {
        dataRange?: [number, number];
        channelRanges?: Array<{
            min: number;
            max: number;
        }>;
    }) => void): void;
    /** Lazily create (and cache) a zero-filled physical brick for a bit depth */
    private getZeroBrick;
    /**
     * Derive a percentile-clipped (p0.1 / p99.9) float data range from base-LOD
     * bricks using a 65536-entry float16 histogram (no per-voxel Math.pow).
     */
    private computeFloatPercentileRange;
    /** Load and pin the coarsest LOD level with bounded concurrency. */
    private loadBaseLod;
    /**
     * Main update loop - call every frame
     * Returns true if any work was done
     */
    update(camera: Camera, canvas: HTMLCanvasElement): void;
    /**
     * Check if camera has moved significantly
     */
    private hasCameraMoved;
    /**
     * Force immediate recomputation of desired set
     */
    forceUpdate(camera: Camera, canvas: HTMLCanvasElement): void;
    /**
     * Clear all state
     */
    clear(): void;
    /**
     * Get current stats
     */
    getStats(): StreamingStats;
    /**
     * Compute the desired set of bricks based on camera position and frustum
     * Uses Screen-Space Error (SSE) for LOD selection
     */
    private computeDesiredSet;
    private addDesiredBrick;
    /**
     * Process pending load requests (non-blocking)
     */
    private processLoadQueue;
    /**
     * Load a single brick with abort support
     */
    private loadBrick;
    private scheduleAccumulationReset;
    private getBrickAABB;
    private getAABBCenter;
    private distance;
    /**
     * Get the world-space size of one voxel at a given LOD level
     * At LOD N, each voxel represents 2^N original voxels
     */
    private getVoxelWorldSize;
    /**
     * Find the parent (coarser LOD) brick that covers the same region
     * Used to restore fallback data when evicting a finer LOD brick
     */
    private findParentBrick;
    /** Check if any child brick (one LOD finer) is loaded or in-flight (SSE hysteresis). */
    private hasResidentChildren;
    /** Check if any ancestor brick is known-empty (for eviction fallback). */
    private hasEmptyAncestor;
}
