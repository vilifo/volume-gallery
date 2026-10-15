// WebGPU renderer for slice panes: one 2D integer/float texture per pane,
// exact window/level in the shader, bilinear when magnified, box filter when
// zoomed out. Values are read with textureLoad, so no sampler and no special
// GPU feature are needed: r8/r16 uint/sint and r32float all work everywhere.

import { textureFormatFor, minifyTaps } from "./geometry.js";
import { TF_SIZE, buildLut, presetStops } from "./transfer-function.js";

const WGSL = (sampleType, toF32) => /* wgsl */ `
struct U {
  a: vec4f,  // target size (px), plane point at the centre (voxels)
  b: vec4f,  // pixels per voxel (u, v), flip (u, v)
  c: vec4f,  // plane extent in voxels (u, v), window centre, window width
  d: vec4f,  // taps per pixel side, stride of the texture, invert (0/1), background
  e: vec4f,  // colour lookup table: enabled (0/1), number of entries
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var plane: texture_2d<${sampleType}>;
@group(0) @binding(2) var lut: texture_2d<f32>;   // transfer function: N x 1 RGBA, indexed by the windowed value


fn texel(p: vec2i) -> f32 {
  let dims = vec2i(textureDimensions(plane));
  let q = clamp(p, vec2i(0), dims - vec2i(1));
  let t = textureLoad(plane, q, 0).r;
  return ${toF32};
}

// continuous texture coordinate (texel i covers [i, i + 1)) -> value
fn bilinear(p: vec2f) -> f32 {
  let f = p - vec2f(0.5);
  let i = vec2i(floor(f));
  let t = f - floor(f);
  let a = texel(i);
  let b = texel(i + vec2i(1, 0));
  let c = texel(i + vec2i(0, 1));
  let d = texel(i + vec2i(1, 1));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = u.a.xy;
  let centre = u.a.zw;
  let ppv = u.b.xy;
  let flip = u.b.zw;
  let extent = u.c.xy;
  let bg = u.d.w;

  let p = centre + flip * (pos.xy - size * 0.5) / ppv;       // plane coordinates, voxels
  if (p.x < 0.0 || p.y < 0.0 || p.x >= extent.x || p.y >= extent.y) {
    return vec4f(bg, bg, bg, 1.0);
  }

  let stride = u.d.y;
  let taps = i32(u.d.x);
  var v = 0.0;
  if (taps <= 1) {
    v = bilinear((p - vec2f(0.5)) / stride + vec2f(0.5));    // texel i holds voxel i * stride
  } else {
    var acc = 0.0;
    for (var j = 0; j < taps; j++) {
      for (var i = 0; i < taps; i++) {
        let o = (vec2f(f32(i), f32(j)) + vec2f(0.5)) / f32(taps) - vec2f(0.5);
        let q = p + flip * o / ppv;
        acc += texel(vec2i(floor((q - vec2f(0.5)) / stride + vec2f(0.5))));
      }
    }
    v = acc / f32(taps * taps);
  }

  var g = clamp((v - (u.c.z - u.c.w * 0.5)) / u.c.w, 0.0, 1.0);
  if (u.d.z > 0.5) { g = 1.0 - g; }
  if (u.e.x > 0.5) {
    let n = u.e.y;
    let f = g * (n - 1.0);
    let i0 = i32(floor(f));
    let i1 = min(i0 + 1, i32(n) - 1);
    let c0 = textureLoad(lut, vec2i(i0, 0), 0).rgb;
    let c1 = textureLoad(lut, vec2i(i1, 0), 0).rgb;
    return vec4f(mix(c0, c1, f - floor(f)), 1.0);
  }
  return vec4f(g, g, g, 1.0);
}
`;

const SAMPLE = {
  uint: { type: "u32", toF32: "f32(t)" },
  sint: { type: "i32", toF32: "f32(t)" },
  float: { type: "f32", toF32: "t" },
};

/** WGSL source for a texture sample kind ("uint" | "sint" | "float"). */
export function shaderSource(sample) {
  const s = SAMPLE[sample];
  return WGSL(s.type, s.toF32);
}

/** The 20 floats of the uniform block (see the struct U in the shader). */
export function buildUniforms(v, stride = 1) {
  const taps = stride > 1 ? 1 : minifyTaps(v.ppv);
  return new Float32Array([
    v.width, v.height, v.view.centerU, v.view.centerV,
    v.ppv.u, v.ppv.v, v.flip.u, v.flip.v,
    v.extent.u, v.extent.v, v.window.center, Math.max(v.window.width, 1e-6),
    taps, stride, v.invert ? 1 : 0, v.background ?? 0.06,
    v.lut ? 1 : 0, TF_SIZE, 0, 0,
  ]);
}

export class SliceRenderer {
  /** @param {GPUDevice} device */
  constructor(device) {
    this.device = device;
    this._pipelines = new Map();
    this.uploadBytes = 0;
    // One transfer function (colour lookup table) shared by every pane
    this.lutTexture = device.createTexture({
      size: [TF_SIZE, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.setLut(buildLut(presetStops("gray")));
  }

  /** Uploads the transfer function: TF_SIZE RGBA entries (see transfer-function.js). */
  setLut(rgba) {
    this.device.queue.writeTexture({ texture: this.lutTexture }, rgba, { bytesPerRow: TF_SIZE * 4 }, [TF_SIZE, 1]);

  }

  _pipeline(sample, targetFormat) {
    const key = `${sample}/${targetFormat}`;
    let p = this._pipelines.get(key);
    if (!p) {
      const module = this.device.createShaderModule({ code: shaderSource(sample) });
      p = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: targetFormat }] },
        primitive: { topology: "triangle-list" },
      });
      this._pipelines.set(key, p);
    }
    return p;
  }

  /** Per-pane GPU state (texture + uniform buffer). */
  createPane() {
    return {
      texture: null,
      format: null,
      width: 0,
      height: 0,
      plane: null,
      uniforms: this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      bindGroups: new Map(),
    };
  }

  /** Uploads a plane ({width, height, dtype, data}) into the pane's texture. */
  upload(pane, plane) {
    const fmt = textureFormatFor(plane.dtype);
    if (!fmt) throw new Error(`Unsupported plane data type ${plane.dtype}`);
    const max = this.device.limits.maxTextureDimension2D;
    if (plane.width > max || plane.height > max) {
      throw new Error(`Plane ${plane.width}x${plane.height} exceeds the GPU texture limit (${max})`);
    }
    if (!pane.texture || pane.width !== plane.width || pane.height !== plane.height || pane.format !== fmt.format) {
      pane.texture?.destroy();
      pane.texture = this.device.createTexture({
        size: [plane.width, plane.height],
        format: fmt.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      pane.format = fmt.format;
      pane.width = plane.width;
      pane.height = plane.height;
      pane.bindGroups.clear();
    }
    this.device.queue.writeTexture(
      { texture: pane.texture },
      plane.data,
      { bytesPerRow: plane.width * fmt.bytes, rowsPerImage: plane.height },
      [plane.width, plane.height],
    );
    pane.plane = { axis: plane.axis, index: plane.index, stride: plane.stride ?? 1, dtype: plane.dtype };
    this.uploadBytes += plane.data.byteLength;
  }

  /**
   * Draws the pane's current plane into `target` (a GPUTextureView of `targetFormat`).
   * @param {object} v
   * @param {number} v.width @param {number} v.height   target size in pixels
   * @param {{u:number,v:number}} v.extent   plane size in voxels
   * @param {{centerU:number,centerV:number}} v.view
   * @param {{u:number,v:number}} v.ppv   target pixels per voxel
   * @param {{u:number,v:number}} v.flip
   * @param {{center:number,width:number}} v.window
   */
  draw(pane, target, targetFormat, v) {
    const dtype = pane.plane?.dtype;
    const fmt = dtype && textureFormatFor(dtype);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0.06, g: 0.06, b: 0.07, a: 1 } }],
    });
    if (fmt && pane.texture) {
      this.device.queue.writeBuffer(pane.uniforms, 0, buildUniforms(v, pane.plane.stride));
      const pipeline = this._pipeline(fmt.sample, targetFormat);
      const key = `${fmt.sample}/${targetFormat}`;
      let bg = pane.bindGroups.get(key);
      if (!bg) {
        bg = this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: pane.uniforms } },
            { binding: 1, resource: pane.texture.createView() },
            { binding: 2, resource: this.lutTexture.createView() },
          ],
        });
        pane.bindGroups.set(key, bg);
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroyPane(pane) {
    pane.texture?.destroy();
    pane.uniforms.destroy();
    pane.texture = null;
    pane.bindGroups.clear();
  }

  dispose() {
    this._pipelines.clear();
    this.lutTexture.destroy();
  }
}

/** Requests a device suitable for the slice panes. Returns null when WebGPU is unavailable. */
export async function requestSliceDevice() {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
    },
  });
  return device;
}
