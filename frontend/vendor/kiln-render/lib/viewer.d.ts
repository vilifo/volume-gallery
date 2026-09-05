/**
 * KilnViewer — self-contained WebGPU volume renderer. Handles WebGPU init,
 * data provider setup, render loop, and resize. App layer handles UI.
 */
import { Renderer, VolumeRenderMode } from './core/renderer.js';
import { Camera, UpAxis } from './core/camera.js';
import { TransferFunction, TFPreset } from './core/transfer-function.js';
import { StreamingManager } from './streaming/streaming-manager.js';
import type { DataProvider, VolumeMetadata } from './data/data-provider.js';
export interface ViewerOptions {
    /** Initial render mode */
    mode?: VolumeRenderMode;
    /** 16-bit window centre (0–1) */
    windowCenter?: number;
    /** 16-bit window width (0–1) */
    windowWidth?: number;
    /** DVR density / opacity scale (0.1–10, default 1) */
    densityScale?: number;
    /** Isosurface threshold (0–1) */
    isoValue?: number;
    /** Render resolution scale (0.25–1) */
    renderScale?: number;
    /** LOD screen-space error threshold in pixels */
    maxPixelError?: number;
    /**
     * Atlas VRAM budget in bytes (default ~1.3 GiB). The grid shrinks to fit;
     * lower it for constrained mobile GPUs, raise it to keep 660³ for many channels.
     */
    atlasBudgetBytes?: number;
    /** Axis-aligned clip minimum, normalised 0–1 */
    clipMin?: [number, number, number];
    /** Axis-aligned clip maximum, normalised 0–1 */
    clipMax?: [number, number, number];
    /** Transfer function colour preset */
    tfPreset?: TFPreset;
    /** Transfer function opacity control points (overrides preset defaults) */
    tfPoints?: Array<{
        x: number;
        y: number;
    }>;
    /** Camera up axis */
    upAxis?: UpAxis;
    /** Camera orbit state [rx, ry, dist] or [rx, ry, dist, tx, ty, tz] */
    cam?: [number, number, number] | [number, number, number, number, number, number];
    /** performance.now() at page load, used for time-to-first-render metric */
    pageLoadStart?: number;
    /** Slice plane positions, normalised 0–1 */
    sliceX?: number;
    sliceY?: number;
    sliceZ?: number;
    /** Slice plane visibility flags (default true) */
    showSliceX?: boolean;
    showSliceY?: boolean;
    showSliceZ?: boolean;
    /** Overlay toggles */
    showWireframe?: boolean;
    showAxis?: boolean;
}
/** Serialisable snapshot of viewer state — used by the share-URL feature */
export interface ViewerState {
    mode: VolumeRenderMode;
    windowCenter: number;
    windowWidth: number;
    densityScale: number;
    isoValue: number;
    /** User-intended render scale (not the 0.25 interaction override) */
    renderScale: number;
    tfPreset: TFPreset;
    tfPoints: Array<{
        x: number;
        y: number;
    }>;
    upAxis: UpAxis;
    cam: [number, number, number, number, number, number];
    clipMin: [number, number, number];
    clipMax: [number, number, number];
    sliceX: number;
    sliceY: number;
    sliceZ: number;
    showSliceX: boolean;
    showSliceY: boolean;
    showSliceZ: boolean;
    showWireframe: boolean;
    showAxis: boolean;
}
export declare class KilnViewer {
    readonly renderer: Renderer;
    readonly camera: Camera;
    readonly transferFunction: TransferFunction;
    readonly streamingManager: StreamingManager;
    readonly device: GPUDevice;
    readonly metadata: VolumeMetadata;
    /** Optional callback invoked at the start of every render frame. */
    onBeforeFrame?: () => void;
    /** Callback invoked when float/channel ranges are derived during base LOD loading. */
    onChannelWindowsChanged?: () => void;
    private readonly dataProvider;
    private readonly context;
    private readonly canvas;
    private readonly resizeObserver;
    private rafHandle;
    private resizeTimer;
    /** User-intended render scale; the frame loop may temporarily override it to
     *  0.25 during camera interaction. */
    private userRenderScale;
    private disposed;
    private dirty;
    private lastCameraVersion;
    private constructor();
    /** Create a fully initialised KilnViewer from a URL or DataProvider. */
    static create(canvas: HTMLCanvasElement, dataset: string | DataProvider, options?: ViewerOptions): Promise<KilnViewer>;
    get mode(): VolumeRenderMode;
    set mode(value: VolumeRenderMode);
    get isoValue(): number;
    set isoValue(value: number);
    get windowCenter(): number;
    set windowCenter(value: number);
    get windowWidth(): number;
    set windowWidth(value: number);
    /** Minimum raw float value that maps to 0.0 in the shader (float32 datasets only). */
    get floatMin(): number;
    set floatMin(value: number);
    /** Maximum raw float value that maps to 1.0 in the shader (float32 datasets only). */
    get floatMax(): number;
    set floatMax(value: number);
    get renderScale(): number;
    set renderScale(value: number);
    getState(): ViewerState;
    dispose(): void;
    private resize;
    private frame;
}
