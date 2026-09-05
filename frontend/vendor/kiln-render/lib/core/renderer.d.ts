/**
 * Volume Renderer using proxy box geometry
 */
import { Camera } from './camera.js';
import { TransferFunction } from './transfer-function.js';
import { VolumeResources } from './volume-resources.js';
import type { DatasetConfig } from './config.js';
export type VolumeRenderMode = 'dvr' | 'mip' | 'iso' | 'lod' | 'slice' | 'slice-lod';
export declare class Renderer {
    private device;
    /** Volume atlas textures, indirection table, and slot allocator */
    readonly resources: VolumeResources;
    get numChannels(): number;
    get canvas(): import("./volume.js").VolumeCanvas;
    get canvases(): import("./volume.js").VolumeCanvas[];
    useIndirection: boolean;
    showWireframe: boolean;
    densityScale: number;
    showAxis: boolean;
    enableJitter: boolean;
    enableTAA: boolean;
    volumeRenderMode: VolumeRenderMode;
    isoValue: number;
    windowCenter: number;
    windowWidth: number;
    floatMin: number;
    floatMax: number;
    clipMin: Float32Array<ArrayBuffer>;
    clipMax: Float32Array<ArrayBuffer>;
    sliceX: number;
    sliceY: number;
    sliceZ: number;
    showSliceX: boolean;
    showSliceY: boolean;
    showSliceZ: boolean;
    renderScale: number;
    private wireframePipeline;
    private axisPipeline;
    private slicePipeline;
    private sliceBindGroup;
    private sliceUniformBuffer;
    private computePipeline;
    private blitPipeline;
    private computeUniformBuffer;
    private accumPipeline;
    private accumUniformBuffer;
    private scaleSets;
    private active;
    private prevVP;
    private wireframeBindGroup;
    private axisBindGroup;
    private vertexBuffer;
    private wireframeIndexBuffer;
    private wireframeUniformBuffer;
    private axisVertexBuffer;
    private axisUniformBuffer;
    private depthTexture;
    private depthView;
    private volumeSampler;
    private tfSampler;
    private blitSampler;
    private tfTexture;
    private wireframeIndexCount;
    private screenWidth;
    private screenHeight;
    private frameIndex;
    private readonly config;
    readonly channelColors: Float32Array<ArrayBuffer>;
    readonly channelWindowCenter: Float32Array<ArrayBuffer>;
    readonly channelWindowWidth: Float32Array<ArrayBuffer>;
    private readonly vpScratch;
    private readonly invVPScratch;
    private readonly computeUniformScratch;
    private readonly computeUniformView;
    private readonly accumScratch;
    private readonly sliceUniformScratch;
    private readonly sliceUniformView;
    constructor(device: GPUDevice, format: GPUTextureFormat, resources: VolumeResources, config: DatasetConfig);
    /** Callback invoked when the scene needs a re-render (parameter change, brick arrival, etc.) */
    onDirty?: () => void;
    /** Signal that the scene changed and needs a re-render (without resetting accumulation) */
    markDirty(): void;
    /** Reset temporal accumulation (call when rendering parameters change) */
    resetAccumulation(): void;
    /** Whether the image is stable (no further rendering will change the output) */
    private get isSliceMode();
    get isConverged(): boolean;
    /** Set the display color and intensity weight for a channel (0–3). Resets accumulation. */
    setChannelColor(ch: number, r: number, g: number, b: number, a?: number): void;
    /** Set the window center and width for a channel (0–3). Resets accumulation. */
    setChannelWindow(ch: number, center: number, width: number): void;
    /**
     * Set the transfer function and recreate bind groups
     */
    setTransferFunction(tf: TransferFunction): void;
    private recreateVolumeBindGroups;
    resize(width: number, height: number): void;
    prepareScale(scale: number): void;
    /** switch to a pre-allocated scale set */
    activateScale(scale: number): void;
    private buildScaleSet;
    private destroyScaleSet;
    private rebuildScaleSetBindGroups;
    private updateSliceUniforms;
    render(colorView: GPUTextureView, camera: Camera): void;
    private getRenderModeInt;
    /** Get depth view for external renderers (debug wireframes, etc) */
    getDepthView(): GPUTextureView;
    /** Get view-projection matrix for external renderers */
    getViewProjMatrix(camera: Camera): Float32Array;
    private renderCompute;
}
