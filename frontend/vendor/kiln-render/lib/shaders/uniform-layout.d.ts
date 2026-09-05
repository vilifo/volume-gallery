/** Single source of truth for WGSL uniform struct layouts. */
interface UniformLayout<T extends string> {
    /** WGSL struct body text (indented field lines) */
    fields: string;
    /** Byte offset of each field (keyed by field name) */
    offsets: Record<T, number>;
    /** Total struct size in bytes (rounded to max alignment) */
    size: number;
}
export declare const COMPUTE_UNIFORMS: UniformLayout<"inverseViewProj" | "cameraPos" | "useIndirection" | "datasetSize" | "renderMode" | "normalizedSize" | "isoValue" | "screenSize" | "frameIndex" | "jitter" | "windowCenter" | "windowWidth" | "floatMin" | "floatMax" | "clipMin" | "densityScale" | "clipMax" | "numChannels" | "channelColors" | "channelWindowCenter" | "channelWindowWidth">;
export declare const SLICE_UNIFORMS: UniformLayout<"datasetSize" | "normalizedSize" | "windowCenter" | "windowWidth" | "floatMin" | "floatMax" | "numChannels" | "channelColors" | "channelWindowCenter" | "channelWindowWidth" | "mvp" | "slicePositions" | "sliceXEnabled" | "sliceYEnabled" | "sliceZEnabled" | "lodDebug">;
export {};
