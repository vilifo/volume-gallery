/**
 * Atlas Allocator - manages free/used brick slots in the atlas texture.
 * Uses LRU eviction when full, tracking brick metadata for indirection cleanup.
 */
export interface AtlasSlot {
    x: number;
    y: number;
    z: number;
}
export interface BrickMetadata {
    lod: number;
    bx: number;
    by: number;
    bz: number;
    key: string;
}
export interface AllocationResult {
    slot: AtlasSlot;
    slotIndex: number;
    evicted: BrickMetadata | null;
}
export declare class AtlasAllocator {
    private used;
    private pinned;
    private freeList;
    private lastUsedFrame;
    private slotMetadata;
    private readonly gridSize;
    readonly totalSlots: number;
    constructor(gridSize?: number);
    /**
     * Touch a slot to mark it as recently used
     * Call this for every brick in the current desired set
     */
    touch(slotIndex: number, frame: number): void;
    /**
     * Touch a slot by its coordinates
     */
    touchSlot(slot: AtlasSlot, frame: number): void;
    /**
     * Set metadata for a slot (call after loading a brick)
     */
    setMetadata(slotIndex: number, meta: BrickMetadata): void;
    /**
     * Pin a slot so it will never be evicted
     */
    pin(slotIndex: number): void;
    /**
     * Unpin a slot so it can be evicted again
     */
    unpin(slotIndex: number): void;
    /**
     * Check if a slot is pinned
     */
    isPinned(slotIndex: number): boolean;
    /**
     * Get count of pinned slots
     */
    get pinnedCount(): number;
    /**
     * Get metadata for a slot
     */
    getMetadata(slotIndex: number): BrickMetadata | null;
    hasEvictableSlot(currentFrame: number): boolean;
    /** Allocate a slot, evicting the LRU slot if the atlas is full. */
    allocate(frame?: number): AllocationResult | null;
    /**
     * Find the least recently used slot (skips pinned and recently-touched slots)
     */
    private findLRUSlot;
    /**
     * Free a slot back to the pool (explicit free, not LRU eviction)
     */
    free(slot: AtlasSlot): void;
    /**
     * Check if a slot is currently allocated
     */
    isAllocated(slot: AtlasSlot): boolean;
    /**
     * Get number of free slots remaining
     */
    get freeCount(): number;
    /**
     * Get number of used slots
     */
    get usedCount(): number;
    /**
     * Check if atlas is full
     */
    get isFull(): boolean;
    /**
     * Reset allocator (free all slots)
     */
    reset(): void;
    /**
     * Get all currently allocated slots
     */
    getAllocatedSlots(): AtlasSlot[];
    /**
     * Convert slot coordinates to flat index
     */
    slotToIndex(slot: AtlasSlot): number;
    /**
     * Convert flat index to slot coordinates
     */
    indexToSlot(idx: number): AtlasSlot;
}
