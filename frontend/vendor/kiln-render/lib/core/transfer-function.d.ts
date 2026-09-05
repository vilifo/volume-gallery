/**
 * Transfer function - maps density to RGBA color
 */
export type TFPreset = 'grayscale' | 'grayscale-inverted' | 'hot' | 'cool' | 'viridis' | 'plasma' | 'coolwarm' | 'seismic';
export interface OpacityPoint {
    x: number;
    y: number;
}
export declare class TransferFunction {
    private device;
    private size;
    texture: GPUTexture;
    private colorData;
    private opacityPoints;
    preset: TFPreset;
    private histogram;
    constructor(device: GPUDevice);
    setPreset(preset: TFPreset): void;
    private getPresetColor;
    private interpolateColormap;
    setOpacityPoints(points: OpacityPoint[]): void;
    getOpacityPoints(): OpacityPoint[];
    private sampleOpacity;
    private updateTexture;
    setHistogram(histogram: Uint32Array): void;
    renderPreview(canvas: HTMLCanvasElement, windowCenter?: number, windowWidth?: number): void;
    private renderHistogram;
}
