/**
 * Shader module assembly — combines modular WGSL components into
 * complete shader programs (compute, blit, overlays).
 */
export declare function buildComputeShader(atlasSize?: number): string;
export declare const wireframeShader: string;
export declare const axisShader: string;
export declare const blitShader: string;
export declare const accumulateShader: string;
export declare function buildSlicePlanesShader(atlasSize?: number): string;
