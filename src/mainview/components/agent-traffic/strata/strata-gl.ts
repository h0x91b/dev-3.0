/**
 * The Strata stage's WebGL2 renderer: three programs, mesh upload, additive
 * particles, and ground decals.
 *
 * Deliberately dependency-free. A 3D library would be the only one in the tree
 * and the stage needs a fraction of one — the whole surface is `mesh`, `draw`,
 * `particles`, `decal` and `project`. Everything here is imperative GPU state,
 * so it is kept out of React entirely: `TrafficStrata` owns one instance and
 * disposes it, and nothing in this file reads the DOM beyond its own canvas.
 *
 * Failure is a first-class outcome, not a throw into a render: the constructor
 * throws only when WebGL2 is absent, and the caller renders the list fallback the
 * screen already has (§5.9 "Lists work without WebGL").
 */

import { M, rgb, V, type Vec3, type Vec4 } from "./strata-math";
import { MeshBuilder, VERTEX_FLOATS } from "./strata-mesh";

export interface StrataMesh {
	vao: WebGLVertexArrayObject;
	buf: WebGLBuffer;
	count: number;
}

export interface StrataDecal {
	tex: WebGLTexture;
	vao: WebGLVertexArrayObject;
	buf: WebGLBuffer;
}

/** One additive sprite: position, colour, size. Seven floats, packed flat. */
export const PARTICLE_FLOATS = 7;

const SCENE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP;layout(location=1) in vec3 aN;layout(location=2) in vec3 aC;layout(location=3) in float aE;
uniform mat4 uVP;uniform vec3 uOffset;
out vec3 vN;out vec3 vC;out vec3 vP;out float vE;
void main(){vP=aP+uOffset;vN=aN;vC=aC;vE=aE;gl_Position=uVP*vec4(vP,1.);}`;

// Two fixed lights and a rim term, then exposure/fog. `uE` lifts a vertex toward
// its own colour, which is how a status halo reads as lit rather than painted.
const SCENE_FRAG = `#version 300 es
precision highp float;
in vec3 vN;in vec3 vC;in vec3 vP;in float vE;
uniform vec3 uEye;uniform vec3 uFog;uniform float uOpacity;uniform float uDim;uniform float uAmbient;
out vec4 outColor;
void main(){
 vec3 n=normalize(vN);
 float sun=max(dot(n,normalize(vec3(-.4,.85,.3))),0.);
 float rim=max(dot(n,normalize(vec3(.65,.3,-.6))),0.);
 vec3 c=vC*(uAmbient+.83*sun)+vec3(.18,.26,.33)*rim*.28;
 vec3 eye=normalize(uEye-vP);
 float spec=pow(max(dot(reflect(-normalize(vec3(-.4,.85,.3)),n),eye),0.),22.);
 c+=spec*.12;
 c=mix(c,vC*1.4,clamp(vE,0.,1.));
 c*=uDim;
 float fog=1.-exp(-length(uEye-vP)*.0014);
 c=mix(c,uFog,fog);
 outColor=vec4(pow(max(c,vec3(0)),vec3(.9)),uOpacity);
}`;

const PARTICLE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP;layout(location=1) in vec3 aC;layout(location=2) in float aS;
uniform mat4 uVP;uniform float uDPR;
out vec3 vC;
void main(){vC=aC;gl_Position=uVP*vec4(aP,1.);gl_PointSize=clamp(aS*160./gl_Position.w*uDPR,2.,85.);}`;

const PARTICLE_FRAG = `#version 300 es
precision highp float;
in vec3 vC;out vec4 outColor;
void main(){float d=length(gl_PointCoord-.5)*2.;float a=exp(-d*d*4.5)*(1.-smoothstep(.6,1.,d));outColor=vec4(vC,a);}`;

const DECAL_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP;layout(location=1) in vec2 aUV;
uniform mat4 uVP;out vec2 vUV;
void main(){gl_Position=uVP*vec4(aP,1.);vUV=aUV;}`;

const DECAL_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;uniform sampler2D uTexture;uniform float uAlpha;
out vec4 outColor;
void main(){vec4 c=texture(uTexture,vUV);outColor=vec4(c.rgb,c.a*uAlpha);}`;

/** Thrown when the browser has no WebGL2 at all. The caller falls back to lists. */
export class StrataUnsupportedError extends Error {}

export interface StrataPalette {
	/** Distance fog, and what the horizon dissolves into. The scene background. */
	fog: string;
	/** Ambient floor. Higher on light themes, or every unlit face reads as a hole. */
	ambient: number;
	/** Deck-decal title and subtitle ink. */
	decalTitle: string;
	decalSub: string;
	/** Decal opacity — etched into the deck, never a label sitting on it. */
	decalAlpha: number;
}

export class StrataGL {
	readonly gl: WebGL2RenderingContext;
	private readonly canvas: HTMLCanvasElement;
	private readonly prog: WebGLProgram;
	private readonly particleProg: WebGLProgram;
	private readonly decalProg: WebGLProgram;
	private readonly pbuf: WebGLBuffer;
	private readonly pvao: WebGLVertexArrayObject;
	private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
	private vp: Float32Array<ArrayBufferLike> = new Float32Array(16);
	private eye: Vec3 = [0, 55, 65];
	private palette: StrataPalette;
	/** Live buffer count — a mount that leaks meshes shows up here in tests. */
	allocations = 0;
	w = 1;
	h = 1;
	dpr = 1;

	constructor(canvas: HTMLCanvasElement, palette: StrataPalette) {
		const gl = canvas.getContext("webgl2", {
			antialias: true,
			alpha: true,
			powerPreference: "high-performance",
		});
		if (!gl) throw new StrataUnsupportedError("WebGL2 is unavailable");
		this.canvas = canvas;
		this.gl = gl;
		this.palette = palette;
		this.prog = this.program(SCENE_VERT, SCENE_FRAG);
		this.particleProg = this.program(PARTICLE_VERT, PARTICLE_FRAG);
		this.decalProg = this.program(DECAL_VERT, DECAL_FRAG);
		const pbuf = gl.createBuffer();
		const pvao = gl.createVertexArray();
		if (!pbuf || !pvao) throw new StrataUnsupportedError("WebGL2 buffers unavailable");
		this.pbuf = pbuf;
		this.pvao = pvao;
		gl.bindVertexArray(pvao);
		gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
		for (const [index, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24]] as const) {
			gl.enableVertexAttribArray(index);
			gl.vertexAttribPointer(index, size, gl.FLOAT, false, PARTICLE_FLOATS * 4, offset);
		}
		gl.bindVertexArray(null);
	}

	setPalette(palette: StrataPalette): void {
		this.palette = palette;
	}

	private program(vertex: string, fragment: string): WebGLProgram {
		const gl = this.gl;
		const program = gl.createProgram();
		if (!program) throw new StrataUnsupportedError("WebGL2 program unavailable");
		for (const [type, source] of [
			[gl.VERTEX_SHADER, vertex],
			[gl.FRAGMENT_SHADER, fragment],
		] as const) {
			const shader = gl.createShader(type);
			if (!shader) throw new StrataUnsupportedError("WebGL2 shader unavailable");
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
			}
			gl.attachShader(program, shader);
			gl.deleteShader(shader);
		}
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
		}
		return program;
	}

	private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
		let locations = this.uniforms.get(program);
		if (!locations) {
			locations = new Map();
			this.uniforms.set(program, locations);
		}
		if (!locations.has(name)) locations.set(name, this.gl.getUniformLocation(program, name));
		return locations.get(name) ?? null;
	}

	mesh(builder: MeshBuilder | number[]): StrataMesh {
		const gl = this.gl;
		const v = builder instanceof MeshBuilder ? builder.v : builder;
		const vao = gl.createVertexArray();
		const buf = gl.createBuffer();
		if (!vao || !buf) throw new StrataUnsupportedError("WebGL2 buffers unavailable");
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
		for (const [index, size, offset] of [
			[0, 3, 0], [1, 3, 12], [2, 3, 24], [3, 1, 36],
		] as const) {
			gl.enableVertexAttribArray(index);
			gl.vertexAttribPointer(index, size, gl.FLOAT, false, VERTEX_FLOATS * 4, offset);
		}
		gl.bindVertexArray(null);
		this.allocations++;
		return { vao, buf, count: v.length / VERTEX_FLOATS };
	}

	dispose(mesh: StrataMesh | null | undefined): void {
		if (!mesh) return;
		this.gl.deleteBuffer(mesh.buf);
		this.gl.deleteVertexArray(mesh.vao);
		this.allocations--;
	}

	disposeDecal(decal: StrataDecal | null | undefined): void {
		if (!decal) return;
		this.gl.deleteTexture(decal.tex);
		this.gl.deleteBuffer(decal.buf);
		this.gl.deleteVertexArray(decal.vao);
	}

	/**
	 * Match the drawing buffer to the CSS box. DPR is capped at 1.7 — beyond that
	 * a 4K stage pays for pixels nobody can tell apart, and the whole scene is
	 * rebuilt on every resize.
	 */
	resize(): void {
		const rect = this.canvas.getBoundingClientRect();
		this.w = Math.max(1, rect.width);
		this.h = Math.max(1, rect.height);
		this.dpr = Math.min(window.devicePixelRatio || 1, 1.7);
		const w = Math.max(1, Math.round(this.w * this.dpr));
		const h = Math.max(1, Math.round(this.h * this.dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
		this.gl.viewport(0, 0, w, h);
	}

	/**
	 * Start a frame.
	 *
	 * `far` follows the camera rather than sitting at a fixed 650. A fixed plane
	 * silently clipped the scene the moment a wide board on a narrow stage needed
	 * the camera pulled back past it — the framing was correct and the geometry
	 * simply vanished. The near plane stays at 0.5, and the ratio only grows with
	 * distance, so depth precision at the decks is unaffected.
	 */
	begin(eye: Vec3, target: Vec3, far = 650): void {
		const gl = this.gl;
		this.eye = eye;
		this.vp = M.mul(
			M.persp((40 * Math.PI) / 180, this.w / this.h, 0.5, Math.max(120, far)),
			M.look(eye, target),
		);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(true);
	}

	draw(
		mesh: StrataMesh,
		{ offset = [0, 0, 0] as Vec3, opacity = 1, dim = 1 } = {},
	): void {
		const gl = this.gl;
		const p = this.prog;
		gl.useProgram(p);
		gl.uniformMatrix4fv(this.uniform(p, "uVP"), false, this.vp);
		gl.uniform3fv(this.uniform(p, "uOffset"), offset);
		gl.uniform3fv(this.uniform(p, "uEye"), this.eye);
		gl.uniform3fv(this.uniform(p, "uFog"), rgb(this.palette.fog));
		gl.uniform1f(this.uniform(p, "uOpacity"), opacity);
		gl.uniform1f(this.uniform(p, "uDim"), dim);
		gl.uniform1f(this.uniform(p, "uAmbient"), this.palette.ambient);
		gl.bindVertexArray(mesh.vao);
		gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
	}

	/** Additive sprites, drawn depth-read but not depth-written so they layer. */
	particles(v: number[]): void {
		if (!v.length) return;
		const gl = this.gl;
		const p = this.particleProg;
		gl.useProgram(p);
		gl.uniformMatrix4fv(this.uniform(p, "uVP"), false, this.vp);
		gl.uniform1f(this.uniform(p, "uDPR"), this.dpr);
		gl.bindVertexArray(this.pvao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.pbuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
		gl.depthMask(false);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
		gl.drawArrays(gl.POINTS, 0, v.length / PARTICLE_FLOATS);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(true);
	}

	/** World point to CSS pixels, for the DOM label layer and hit testing. */
	project(p: Vec3): { x: number; y: number; depth: number; visible: boolean } {
		const q: Vec4 = M.apply(this.vp, p);
		return {
			x: (((q[0] / q[3]) * 0.5 + 0.5)) * this.w,
			y: ((-0.5 * q[1]) / q[3] + 0.5) * this.h,
			depth: q[3],
			visible: q[3] > 0 && q[2] / q[3] < 1,
		};
	}

	/**
	 * A deck decal: the district's name etched flat into its platform.
	 *
	 * Text drawn into a 2D canvas and uploaded once, rather than a DOM label —
	 * a decal lies in the plane of the deck and shrinks with perspective, so it
	 * reads as part of the platform and never competes with the floating card
	 * labels above it.
	 */
	decal(
		x: number, y: number, z: number,
		w: number, d: number,
		title: string, sub: string,
	): StrataDecal | null {
		const cv = document.createElement("canvas");
		cv.width = 1024;
		cv.height = 256;
		const c = cv.getContext("2d");
		const gl = this.gl;
		const tex = gl.createTexture();
		const vao = gl.createVertexArray();
		const buf = gl.createBuffer();
		if (!c || !tex || !vao || !buf) return null;
		c.fillStyle = this.palette.decalTitle;
		c.font = "600 78px system-ui, sans-serif";
		c.fillText(title, 12, 100, 1000);
		c.font = "30px ui-monospace, monospace";
		c.fillStyle = this.palette.decalSub;
		c.fillText(sub, 16, 164, 990);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const data = [
			x - w / 2, y, z - d / 2, 0, 0,
			x + w / 2, y, z - d / 2, 1, 0,
			x + w / 2, y, z + d / 2, 1, 1,
			x - w / 2, y, z - d / 2, 0, 0,
			x + w / 2, y, z + d / 2, 1, 1,
			x - w / 2, y, z + d / 2, 0, 1,
		];
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
		for (const [index, size, offset] of [[0, 3, 0], [1, 2, 12]] as const) {
			gl.enableVertexAttribArray(index);
			gl.vertexAttribPointer(index, size, gl.FLOAT, false, 20, offset);
		}
		gl.bindVertexArray(null);
		return { tex, vao, buf };
	}

	drawDecal(decal: StrataDecal): void {
		const gl = this.gl;
		const p = this.decalProg;
		gl.useProgram(p);
		gl.uniformMatrix4fv(this.uniform(p, "uVP"), false, this.vp);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, decal.tex);
		gl.uniform1i(this.uniform(p, "uTexture"), 0);
		gl.uniform1f(this.uniform(p, "uAlpha"), this.palette.decalAlpha);
		gl.bindVertexArray(decal.vao);
		gl.depthMask(false);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		gl.depthMask(true);
	}

	/**
	 * Release every GPU object this instance owns.
	 *
	 * The stage switch unmounts the other presentation, so a leak here is a leak
	 * per switch, not once per session — `WEBGL_lose_context` is the only way to
	 * hand the driver back its memory promptly.
	 */
	destroy(): void {
		const gl = this.gl;
		gl.deleteBuffer(this.pbuf);
		gl.deleteVertexArray(this.pvao);
		for (const program of [this.prog, this.particleProg, this.decalProg]) {
			gl.deleteProgram(program);
		}
		this.uniforms.clear();
		gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}

/** Re-exported so scene code imports one module. */
export { MeshBuilder, V };
