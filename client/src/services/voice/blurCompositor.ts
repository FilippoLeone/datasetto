/**
 * Draws a camera frame with its background blurred, on the GPU (WebGL 2), from a person
 * mask at the segmenter's low resolution. Runs in the blur worker on an OffscreenCanvas
 * (or on the page, the code does not care).
 *
 * Passes per frame, all on full-screen triangles:
 * 1. a new mask is blended with the previous one (fast where it changed a lot, slow where it
 *    only flickers), at the mask's own resolution;
 * 2. the frame is reduced to the mask's size (the guide for step 5) and to a quarter of its
 *    size, each pixel of the latter weighted by how much it is background, so the person's
 *    colours never bleed into the blurred room (no halo);
 * 3. a separable Gaussian blurs that weighted image (once for Light, twice for Strong);
 * 4. the result is divided by its weight;
 * 5. at the frame's full size the mask is upsampled edge-aware (a joint bilateral filter:
 *    nearby mask cells count more when their colour matches the pixel's), so the edge
 *    follows the person's outline instead of the mask's 5-pixel grid, then the sharp frame
 *    and the blurred room are mixed through a narrow feathered edge into the canvas.
 *
 * Before the first mask arrives everything counts as background, so the room is never sent
 * sharp while the model loads.
 */

export interface BlurLookParams {
  /** Gaussian sigma as a share of the frame height. */
  sigma: number;
  passes: 1 | 2;
  /** Half width of the soft edge, in mask confidence (0..0.5). */
  feather: number;
}

/** What the canvas shows: the result, or (for tuning) the person mask as grey levels. */
export type CompositorView = 'result' | 'mask';

const VERTEX = `#version 300 es
uniform bool u_flipY;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  if (u_flipY) v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** New mask blended into the previous one; the blend follows real movement quickly and damps flicker. */
const SMOOTH_MASK = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_raw;
uniform sampler2D u_prev;
uniform bool u_first;
out vec4 outColor;
void main() {
  float raw = texture(u_raw, v_uv).r;
  if (u_first) { outColor = vec4(raw, 0.0, 0.0, 1.0); return; }
  float prev = texture(u_prev, v_uv).r;
  float change = abs(raw - prev);
  float rate = mix(0.45, 0.95, smoothstep(0.15, 0.6, change));
  outColor = vec4(mix(prev, raw, rate), 0.0, 0.0, 1.0);
}`;

/** The frame averaged down to the mask's grid: the colours the joint bilateral filter compares. */
const GUIDE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform vec2 u_cell;
out vec4 outColor;
void main() {
  vec2 q = u_cell * 0.25;
  outColor = vec4((texture(u_frame, v_uv + vec2(-q.x, -q.y)).rgb + texture(u_frame, v_uv + vec2(q.x, -q.y)).rgb
    + texture(u_frame, v_uv + vec2(-q.x, q.y)).rgb + texture(u_frame, v_uv + vec2(q.x, q.y)).rgb) * 0.25, 1.0);
}`;

/**
 * Quarter-size copy of the frame, premultiplied by the background weight (alpha = weight).
 * Four bilinear taps average a 4x4 block. The weight treats half-sure pixels as person, so
 * the person's edge does not leak into the background estimate.
 */
const DOWNSAMPLE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform vec2 u_texel;
out vec4 outColor;
vec4 tap(vec2 uv) {
  vec3 rgb = texture(u_frame, uv).rgb;
  float person = u_hasMask ? smoothstep(0.15, 0.45, texture(u_mask, uv).r) : 0.0;
  float w = 1.0 - person;
  return vec4(rgb * w, w);
}
void main() {
  vec4 sum = tap(v_uv + u_texel * vec2(-1.0, -1.0)) + tap(v_uv + u_texel * vec2(1.0, -1.0))
    + tap(v_uv + u_texel * vec2(-1.0, 1.0)) + tap(v_uv + u_texel * vec2(1.0, 1.0));
  outColor = sum * 0.25;
}`;

const MAX_TAPS = 9;

/** Separable Gaussian with paired taps (one bilinear fetch covers two texels). */
const BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform int u_taps;
uniform float u_offsets[${MAX_TAPS}];
uniform float u_weights[${MAX_TAPS}];
out vec4 outColor;
void main() {
  vec4 sum = texture(u_src, v_uv) * u_weights[0];
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= u_taps) break;
    vec2 off = u_dir * u_offsets[i];
    sum += (texture(u_src, v_uv + off) + texture(u_src, v_uv - off)) * u_weights[i];
  }
  outColor = sum;
}`;

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_bg;
uniform sampler2D u_mask;
uniform sampler2D u_guide;
uniform vec2 u_maskSize;
uniform bool u_hasMask;
uniform float u_feather;
uniform int u_view;
out vec4 outColor;

// Joint bilateral upsampling of the mask: the 3x3 mask cells around the pixel, each weighted
// by its distance (in cells) and by how close its average colour is to the pixel's colour.
float personAt(vec2 uv, vec3 color) {
  vec2 pos = uv * u_maskSize - 0.5;
  vec2 center = floor(pos + 0.5);
  float acc = 0.0;
  float total = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = center + vec2(float(dx), float(dy));
      vec2 cuv = (cell + 0.5) / u_maskSize;
      vec2 d = cell - pos;
      vec3 dc = texture(u_guide, cuv).rgb - color;
      float w = exp(-dot(d, d) * 0.7 - dot(dc, dc) * 40.0) + 1e-5;
      acc += texture(u_mask, cuv).r * w;
      total += w;
    }
  }
  return acc / total;
}

void main() {
  vec3 sharp = texture(u_frame, v_uv).rgb;
  float person = u_hasMask ? smoothstep(0.5 - u_feather, 0.5 + u_feather, personAt(v_uv, sharp)) : 0.0;
  if (u_view == 1) { outColor = vec4(vec3(person), 1.0); return; }
  vec4 bg = texture(u_bg, v_uv);
  // Deep inside the person there is no background to average: the sharp frame shows there anyway.
  vec3 blurred = bg.a > 0.004 ? bg.rgb / bg.a : sharp;
  outColor = vec4(mix(blurred, sharp, person), 1.0);
}`;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  uniforms: Uniforms;
}

/** Discrete Gaussian folded into paired bilinear taps: offsets (in texels) and weights summing to 1. */
export const gaussianTaps = (sigma: number, maxTaps = MAX_TAPS): { offsets: number[]; weights: number[] } => {
  const s = Math.max(0.5, sigma);
  const radius = Math.min((maxTaps - 1) * 2, Math.max(1, Math.ceil(s * 3)));
  const raw: number[] = [];
  for (let i = 0; i <= radius; i++) raw.push(Math.exp(-(i * i) / (2 * s * s)));
  const total = raw[0] + 2 * raw.slice(1).reduce((a, b) => a + b, 0);
  const offsets = [0];
  const weights = [raw[0] / total];
  for (let i = 1; i <= radius; i += 2) {
    const a = raw[i] / total;
    const b = i + 1 <= radius ? raw[i + 1] / total : 0;
    const w = a + b;
    offsets.push(w > 0 ? (i * a + (i + 1) * b) / w : i);
    weights.push(w);
  }
  return { offsets, weights };
};

export class BlurCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly smooth: Program;
  private readonly guidePass: Program;
  private readonly down: Program;
  private readonly blur: Program;
  private readonly composite: Program;
  private readonly frameTexture: WebGLTexture;
  private readonly rawMask: WebGLTexture;
  private masks: [Target | null, Target | null] = [null, null];
  private currentMask = 0;
  private hasMask = false;
  private guide: Target | null = null;
  private bg: [Target | null, Target | null] = [null, null];
  private width = 0;
  private height = 0;
  private maskBytes: Uint8Array | null = null;
  view: CompositorView = 'result';
  lost = false;

  constructor(readonly canvas: OffscreenCanvas | HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    (canvas as EventTarget).addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
    });
    this.vao = gl.createVertexArray()!;
    this.smooth = this.program(SMOOTH_MASK, ['u_raw', 'u_prev', 'u_first']);
    this.guidePass = this.program(GUIDE, ['u_frame', 'u_cell']);
    this.down = this.program(DOWNSAMPLE, ['u_frame', 'u_mask', 'u_hasMask', 'u_texel']);
    this.blur = this.program(BLUR, ['u_src', 'u_dir', 'u_taps', 'u_offsets', 'u_weights']);
    this.composite = this.program(COMPOSITE, ['u_frame', 'u_bg', 'u_mask', 'u_guide', 'u_maskSize', 'u_hasMask', 'u_feather', 'u_view']);
    this.frameTexture = this.texture();
    this.rawMask = this.texture();
  }

  private program(fragment: string, names: string[]): Program {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader failed: ' + gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program failed: ' + gl.getProgramInfoLog(program));
    const uniforms: Uniforms = { u_flipY: gl.getUniformLocation(program, 'u_flipY') };
    for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private target(width: number, height: number, format: 'r8' | 'rgba8', previous: Target | null): Target {
    const gl = this.gl;
    if (previous && previous.width === width && previous.height === height) return previous;
    if (previous) {
      gl.deleteTexture(previous.texture);
      gl.deleteFramebuffer(previous.framebuffer);
    }
    const texture = this.texture();
    if (format === 'r8') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer is not complete');
    return { texture, framebuffer, width, height };
  }

  private bindTexture(unit: number, texture: WebGLTexture, uniform: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniform, unit);
  }

  private draw(program: Program, target: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, target ? target.width : this.width, target ? target.height : this.height);
    gl.uniform1i(program.uniforms.u_flipY, target ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** A new person mask (confidence 0..1, row 0 at the top) from the segmenter. */
  updateMask(confidence: Float32Array, width: number, height: number): void {
    const gl = this.gl;
    const count = width * height;
    if (!this.maskBytes || this.maskBytes.length !== count) this.maskBytes = new Uint8Array(count);
    const bytes = this.maskBytes;
    for (let i = 0; i < count; i++) {
      const value = confidence[i];
      bytes[i] = value <= 0 ? 0 : value >= 1 ? 255 : (value * 255 + 0.5) | 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.rawMask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    const first = !this.hasMask || !this.masks[0] || this.masks[0].width !== width || this.masks[0].height !== height;
    this.masks[0] = this.target(width, height, 'r8', this.masks[0]);
    this.masks[1] = this.target(width, height, 'r8', this.masks[1]);
    const previous = this.masks[this.currentMask]!;
    const next = this.masks[1 - this.currentMask]!;
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.smooth.program);
    this.bindTexture(0, this.rawMask, this.smooth.uniforms.u_raw);
    this.bindTexture(1, previous.texture, this.smooth.uniforms.u_prev);
    gl.uniform1i(this.smooth.uniforms.u_first, first ? 1 : 0);
    this.draw(this.smooth, next);
    this.currentMask = 1 - this.currentMask;
    this.hasMask = true;
  }

  /** Forget the person (a new camera): everything is background until the next mask. */
  resetMask(): void {
    this.hasMask = false;
  }

  /** Draws `frame` (VideoFrame or ImageBitmap) with the background blurred into the canvas. */
  render(frame: TexImageSource, width: number, height: number, look: BlurLookParams): void {
    const gl = this.gl;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const bgWidth = Math.max(1, Math.round(width / 4));
    const bgHeight = Math.max(1, Math.round(height / 4));
    this.bg[0] = this.target(bgWidth, bgHeight, 'rgba8', this.bg[0]);
    this.bg[1] = this.target(bgWidth, bgHeight, 'rgba8', this.bg[1]);
    const [bgA, bgB] = this.bg as [Target, Target];
    const mask = this.masks[this.currentMask];
    const hasMask = this.hasMask && mask !== null;

    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.bindVertexArray(this.vao);

    if (hasMask) {
      this.guide = this.target(mask.width, mask.height, 'rgba8', this.guide);
      gl.useProgram(this.guidePass.program);
      this.bindTexture(0, this.frameTexture, this.guidePass.uniforms.u_frame);
      gl.uniform2f(this.guidePass.uniforms.u_cell, 1 / mask.width, 1 / mask.height);
      this.draw(this.guidePass, this.guide);
    }

    gl.useProgram(this.down.program);
    this.bindTexture(0, this.frameTexture, this.down.uniforms.u_frame);
    this.bindTexture(1, hasMask ? mask.texture : this.rawMask, this.down.uniforms.u_mask);
    gl.uniform1i(this.down.uniforms.u_hasMask, hasMask ? 1 : 0);
    gl.uniform2f(this.down.uniforms.u_texel, 1 / width, 1 / height);
    this.draw(this.down, bgA);

    const { offsets, weights } = gaussianTaps(look.sigma * bgHeight);
    gl.useProgram(this.blur.program);
    gl.uniform1i(this.blur.uniforms.u_taps, offsets.length);
    gl.uniform1fv(this.blur.uniforms.u_offsets, padded(offsets));
    gl.uniform1fv(this.blur.uniforms.u_weights, padded(weights));
    for (let pass = 0; pass < look.passes; pass++) {
      this.bindTexture(0, bgA.texture, this.blur.uniforms.u_src);
      gl.uniform2f(this.blur.uniforms.u_dir, 1 / bgWidth, 0);
      this.draw(this.blur, bgB);
      this.bindTexture(0, bgB.texture, this.blur.uniforms.u_src);
      gl.uniform2f(this.blur.uniforms.u_dir, 0, 1 / bgHeight);
      this.draw(this.blur, bgA);
    }

    gl.useProgram(this.composite.program);
    this.bindTexture(0, this.frameTexture, this.composite.uniforms.u_frame);
    this.bindTexture(1, bgA.texture, this.composite.uniforms.u_bg);
    this.bindTexture(2, hasMask ? mask.texture : this.rawMask, this.composite.uniforms.u_mask);
    this.bindTexture(3, hasMask && this.guide ? this.guide.texture : this.frameTexture, this.composite.uniforms.u_guide);
    gl.uniform2f(this.composite.uniforms.u_maskSize, hasMask ? mask.width : 1, hasMask ? mask.height : 1);
    gl.uniform1i(this.composite.uniforms.u_hasMask, hasMask ? 1 : 0);
    gl.uniform1f(this.composite.uniforms.u_feather, look.feather);
    gl.uniform1i(this.composite.uniforms.u_view, this.view === 'mask' ? 1 : 0);
    this.draw(this.composite, null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const target of [...this.masks, ...this.bg, this.guide]) {
      if (!target) continue;
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    gl.deleteTexture(this.frameTexture);
    gl.deleteTexture(this.rawMask);
    for (const program of [this.smooth, this.guidePass, this.down, this.blur, this.composite]) gl.deleteProgram(program.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const padded = (values: number[]): Float32Array => {
  const out = new Float32Array(MAX_TAPS);
  out.set(values.slice(0, MAX_TAPS));
  return out;
};
