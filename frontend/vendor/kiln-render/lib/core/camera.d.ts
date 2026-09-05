/** Arcball camera — mouse (orbit/pan/wheel) and touch (orbit/pinch/pan). */
export type UpAxis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';
export declare class Camera {
    position: Float32Array;
    private target;
    private distance;
    private rotationX;
    private rotationY;
    private isDragging;
    private isPanning;
    private lastInteractionTime;
    private lastX;
    private lastY;
    private readonly viewScratch;
    private readonly projScratch;
    private activeTouches;
    private lastPinchDistance;
    private lastTouchCenter;
    private isTouchPanning;
    private upAxis;
    private upVector;
    private poleEpsilon;
    private version_;
    get version(): number;
    constructor(canvas: HTMLCanvasElement);
    private applyOrbit;
    private applyPan;
    /** Calculate distance between two touch points */
    private getTouchDistance;
    /** Calculate midpoint between two touch points */
    private getTouchCenter;
    private updatePosition;
    /** Get screen-space right and up vectors from view matrix for panning */
    private getScreenSpaceVectors;
    /**
     * Set the up axis for camera orientation
     * Supports positive and negative axes: 'x', 'y', 'z', '-x', '-y', '-z'
     */
    setUpAxis(axis: UpAxis): void;
    /** Reset pan to center on origin */
    resetPan(): void;
    getUpAxis(): UpAxis;
    /** Get orbital state: [rotationX, rotationY, distance, targetX, targetY, targetZ] */
    getOrbitState(): [number, number, number, number, number, number];
    /** Set orbital state: [rotationX, rotationY, distance] or [rotationX, rotationY, distance, targetX, targetY, targetZ] */
    setOrbitState(state: [number, number, number] | [number, number, number, number, number, number]): void;
    isInteracting(): boolean;
    getViewMatrix(): Float32Array;
    getProjectionMatrix(aspect: number): Float32Array;
}
/** Frustum planes for culling. Each plane [a,b,c,d]: normal points inward. */
export type FrustumPlanes = {
    left: [number, number, number, number];
    right: [number, number, number, number];
    bottom: [number, number, number, number];
    top: [number, number, number, number];
    near: [number, number, number, number];
    far: [number, number, number, number];
};
/**
 * Extract frustum planes from a view-projection matrix.
 * Uses Gribb/Hartmann method.
 */
export declare function extractFrustumPlanes(viewProj: Float32Array): FrustumPlanes;
/**
 * Test if an AABB intersects or is inside the frustum.
 * Returns true if any part of the box is visible.
 */
export declare function isAABBInFrustum(min: [number, number, number], max: [number, number, number], frustum: FrustumPlanes): boolean;
