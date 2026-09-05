/**
 * BrickCache - CPU-side LRU cache for decompressed brick data.
 * Re-uploads evicted bricks without network round-trip. Bounded by bytes.
 */
import type { BrickData } from '../data/data-provider.js';
export declare class BrickCache {
    private cache;
    private totalBytes;
    private maxBytes;
    constructor(maxBytes?: number);
    get(key: string): BrickData | undefined;
    put(key: string, data: BrickData): void;
    clear(): void;
}
