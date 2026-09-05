/**
 * Box geometry for proxy rendering
 */
export interface BoxGeometry {
    vertices: Float32Array;
    indices: Uint16Array;
    wireframeIndices: Uint16Array;
}
export declare function createBox(size: [number, number, number]): BoxGeometry;
export interface AxisGeometry {
    vertices: Float32Array;
}
export declare function createAxis(size: number): AxisGeometry;
