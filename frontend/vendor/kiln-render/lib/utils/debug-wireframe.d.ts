/** Debug Wireframe Renderer — draws colored wireframe boxes to visualize LOD structure. */
import type { DatasetConfig } from '../core/config.js';
interface WireframeBox {
    center: [number, number, number];
    size: [number, number, number];
    color: [number, number, number, number];
}
export declare class DebugWireframe {
    private device;
    private pipeline;
    private uniformBuffer;
    private uniformBindGroup;
    private vertexBuffer;
    private vertexCount;
    private maxVertices;
    private config;
    enabled: boolean;
    constructor(device: GPUDevice, format: GPUTextureFormat, config: DatasetConfig);
    /**
     * Update wireframe boxes from streaming manager state
     */
    updateFromStreamingManager(streamingManager: {
        getActiveLeaves(): Array<{
            node: {
                lod: number;
                bx: number;
                by: number;
                bz: number;
            };
        }>;
    }, maxLod: number): void;
    /**
     * Set boxes to render
     */
    setBoxes(boxes: WireframeBox[]): void;
    /**
     * Render wireframes
     */
    render(encoder: GPUCommandEncoder, colorView: GPUTextureView, depthView: GPUTextureView, viewProjMatrix: Float32Array): void;
}
export {};
