export type Vec3 = [number, number, number];

export const V = {
	add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
	sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
	mul: (a: Vec3, scale: number): Vec3 => [
		a[0] * scale,
		a[1] * scale,
		a[2] * scale,
	],
	dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
	cross: (a: Vec3, b: Vec3): Vec3 => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	],
	norm: (a: Vec3): Vec3 => V.mul(a, 1 / (Math.hypot(...a) || 1)),
};

const M = {
	mul(a: Float32Array, b: Float32Array): Float32Array {
		const result = new Float32Array(16);
		for (let column = 0; column < 4; column++)
			for (let row = 0; row < 4; row++)
				for (let k = 0; k < 4; k++) {
					result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
				}
		return result;
	},
	perspective(
		field: number,
		aspect: number,
		near: number,
		far: number,
	): Float32Array {
		const q = 1 / Math.tan(field / 2);
		return new Float32Array([
			q / aspect,
			0,
			0,
			0,
			0,
			q,
			0,
			0,
			0,
			0,
			(far + near) / (near - far),
			-1,
			0,
			0,
			(2 * far * near) / (near - far),
			0,
		]);
	},
	look(eye: Vec3, center: Vec3): Float32Array {
		const z = V.norm(V.sub(eye, center));
		const x = V.norm(V.cross([0, 1, 0], z));
		const y = V.cross(z, x);
		return new Float32Array([
			x[0],
			y[0],
			z[0],
			0,
			x[1],
			y[1],
			z[1],
			0,
			x[2],
			y[2],
			z[2],
			0,
			-V.dot(x, eye),
			-V.dot(y, eye),
			-V.dot(z, eye),
			1,
		]);
	},
};

export function bezier(a: Vec3, b: Vec3, height = 5): Vec3[] {
	const middle = V.mul(V.add(a, b), 0.5);
	middle[1] += height;
	return Array.from({ length: 49 }, (_, i) => {
		const t = i / 48;
		return V.add(
			V.add(V.mul(a, (1 - t) ** 2), V.mul(middle, 2 * (1 - t) * t)),
			V.mul(b, t * t),
		);
	});
}

export function curvePoint(points: Vec3[], t: number): Vec3 {
	if (!points.length) return [0, 0, 0];
	if (points.length === 1) return points[0];
	const position = Math.max(0, Math.min(1, t)) * (points.length - 1);
	const index = Math.min(points.length - 2, Math.floor(position));
	return V.add(
		V.mul(points[index], 1 - (position - index)),
		V.mul(points[index + 1], position - index),
	);
}

export class MeshBuilder {
	readonly v: number[] = [];

	private triangle(
		a: Vec3,
		b: Vec3,
		c: Vec3,
		color: Vec3,
		emission: number,
	): void {
		const normal = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
		for (const point of [a, b, c])
			this.v.push(...point, ...normal, ...color, emission);
	}

	private quad(
		a: Vec3,
		b: Vec3,
		c: Vec3,
		d: Vec3,
		color: Vec3,
		emission: number,
	): void {
		this.triangle(a, b, c, color, emission);
		this.triangle(a, c, d, color, emission);
	}

	sphere(
		x: number,
		y: number,
		z: number,
		radius: number,
		color: Vec3,
		longitude = 24,
		latitude = 16,
	): void {
		const point = (a: number, b: number): Vec3 => [
			Math.cos(a) * Math.sin(b),
			Math.cos(b),
			Math.sin(a) * Math.sin(b),
		];
		for (let j = 0; j < latitude; j++)
			for (let i = 0; i < longitude; i++) {
				const a = (i / longitude) * Math.PI * 2,
					b = ((i + 1) / longitude) * Math.PI * 2;
				const c = (j / latitude) * Math.PI,
					d = ((j + 1) / latitude) * Math.PI;
				for (const normal of [
					point(a, c),
					point(a, d),
					point(b, d),
					point(a, c),
					point(b, d),
					point(b, c),
				]) {
					const tint =
						0.82 +
						0.18 *
							Math.sin(
								normal[1] * 22 + normal[0] * 9 + Math.sin(normal[2] * 15),
							);
					this.v.push(
						x + normal[0] * radius,
						y + normal[1] * radius,
						z + normal[2] * radius,
						...normal,
						...V.mul(color, tint),
						radius > 3 ? 0.6 : radius > 1.5 ? 0.23 : 0.07,
					);
				}
			}
	}

	torus(
		x: number,
		y: number,
		z: number,
		radius: number,
		thickness: number,
		color: Vec3,
		emission = 0,
		plane: "xz" | "xy" = "xz",
		arc = Math.PI * 2,
		start = 0,
	): void {
		const segments = Math.max(12, Math.round((48 * arc) / (Math.PI * 2))),
			sides = 6;
		const point = (a: number, b: number): Vec3 => {
			const p: Vec3 = [
				(radius + thickness * Math.cos(b)) * Math.cos(a),
				thickness * Math.sin(b),
				(radius + thickness * Math.cos(b)) * Math.sin(a),
			];
			return plane === "xy"
				? [x + p[0], y + p[2], z + p[1]]
				: [x + p[0], y + p[1], z + p[2]];
		};
		for (let i = 0; i < segments; i++)
			for (let j = 0; j < sides; j++) {
				const a = start + (i / segments) * arc,
					b = start + ((i + 1) / segments) * arc;
				const c = (j / sides) * Math.PI * 2,
					d = ((j + 1) / sides) * Math.PI * 2;
				this.quad(
					point(a, c),
					point(b, c),
					point(b, d),
					point(a, d),
					color,
					emission,
				);
			}
	}

	beam(a: Vec3, b: Vec3, width: number, color: Vec3, emission = 0): void {
		const direction = V.norm(V.sub(b, a));
		let side = V.norm(V.cross(direction, [0, 1, 0]));
		if (Math.hypot(...side) < 0.1) side = [1, 0, 0];
		side = V.mul(side, width / 2);
		const up = V.mul(V.norm(V.cross(direction, side)), width / 2);
		const near = [
			V.add(V.add(a, side), up),
			V.add(V.sub(a, side), up),
			V.sub(V.sub(a, side), up),
			V.sub(V.add(a, side), up),
		];
		const far = near.map((point) => V.add(point, V.sub(b, a)));
		for (let i = 0; i < 4; i++)
			this.quad(
				near[i],
				near[(i + 1) % 4],
				far[(i + 1) % 4],
				far[i],
				color,
				emission,
			);
	}

	path(
		points: Vec3[],
		width: number,
		color: Vec3,
		emission = 0.4,
		dashed = false,
	): void {
		for (let i = 1; i < points.length; i++) {
			if (dashed && i % 5 > 2) continue;
			this.beam(points[i - 1], points[i], width, color, emission);
		}
	}
}

export interface OrbitMesh {
	vao: WebGLVertexArrayObject;
	buf: WebGLBuffer;
	count: number;
}

const MESH_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP;
layout(location=1) in vec3 aN;
layout(location=2) in vec3 aC;
layout(location=3) in float aE;
uniform mat4 uVP;
uniform vec3 uOffset;
out vec3 vN; out vec3 vC; out vec3 vP; out float vE;
void main(){vP=aP+uOffset;vN=aN;vC=aC;vE=aE;gl_Position=uVP*vec4(vP,1.);}`;

const MESH_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vC; in vec3 vP; in float vE;
uniform vec3 uEye; uniform vec3 uFog; uniform float uOpacity; uniform float uDim;
out vec4 outColor;
void main(){
 vec3 n=normalize(vN);
 float sun=max(dot(n,normalize(vec3(-.4,.85,.3))),0.);
 float rim=max(dot(n,normalize(vec3(.65,.3,-.6))),0.);
 float grain=.94+.055*sin(vP.x*3.8+sin(vP.z*2.3))*sin(vP.y*5.4+cos(vP.x*1.7));
 vec3 c=vC*(.15+.78*sun)*grain+vec3(.12,.18,.28)*rim*.25;
 vec3 eye=normalize(uEye-vP);
 float spec=pow(max(dot(reflect(-normalize(vec3(-.4,.85,.3)),n),eye),0.),22.);
 c+=spec*.2;
 float fres=pow(1.-max(dot(n,eye),0.),3.);
 c+=vC*fres*.48;
 c=mix(c,vC*1.4,clamp(vE,0.,1.));c*=uDim;
 float fog=1.-exp(-length(uEye-vP)*.0014);
 c=mix(c,uFog,fog);
 outColor=vec4(pow(max(c,vec3(0)),vec3(.9)),uOpacity);
}`;

const PARTICLE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP; layout(location=1) in vec3 aC; layout(location=2) in float aS;
uniform mat4 uVP; uniform float uDPR; out vec3 vC;
void main(){vC=aC;gl_Position=uVP*vec4(aP,1.);gl_PointSize=clamp(aS*160./gl_Position.w*uDPR,2.,145.);}`;

const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vC; out vec4 outColor;
void main(){float d=length(gl_PointCoord-.5)*2.;float a=exp(-d*d*4.5)*(1.-smoothstep(.6,1.,d));outColor=vec4(vC,a);}`;

function allocated<T>(value: T | null): T {
	if (value === null) throw new Error("Orbit GPU allocation failed");
	return value;
}

export class OrbitGL {
	readonly gl: WebGL2RenderingContext;
	w = 1;
	h = 1;
	dpr = 1;
	private eye: Vec3 = [0, 55, 65];
	private vp: Float32Array = new Float32Array(16);
	private readonly program: WebGLProgram;
	private readonly particleProgram: WebGLProgram;
	private readonly particleBuffer: WebGLBuffer;
	private readonly particleVao: WebGLVertexArrayObject;
	private readonly uniforms = new Map<
		WebGLProgram,
		Map<string, WebGLUniformLocation | null>
	>();
	private readonly meshes = new Set<OrbitMesh>();

	constructor(
		private readonly canvas: HTMLCanvasElement,
		public fog: Vec3,
	) {
		const gl = canvas.getContext("webgl2", {
			antialias: true,
			alpha: true,
			preserveDrawingBuffer: false,
			powerPreference: "high-performance",
		});
		if (!gl) throw new Error("Orbit requires WebGL 2");
		this.gl = gl;
		this.program = this.compileProgram(MESH_VERTEX, MESH_FRAGMENT);
		try {
			this.particleProgram = this.compileProgram(
				PARTICLE_VERTEX,
				PARTICLE_FRAGMENT,
			);
		} catch (error) {
			gl.deleteProgram(this.program);
			throw error;
		}
		const particleBuffer = gl.createBuffer();
		const particleVao = gl.createVertexArray();
		if (!particleBuffer || !particleVao) {
			gl.deleteBuffer(particleBuffer);
			gl.deleteVertexArray(particleVao);
			gl.deleteProgram(this.program);
			gl.deleteProgram(this.particleProgram);
			throw new Error("Orbit GPU allocation failed");
		}
		this.particleBuffer = particleBuffer;
		this.particleVao = particleVao;
		gl.bindVertexArray(this.particleVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
		this.attributes(
			[
				[0, 3, 0],
				[1, 3, 12],
				[2, 1, 24],
			],
			28,
		);
		gl.bindVertexArray(null);
		this.resize();
	}

	private compileProgram(vertex: string, fragment: string): WebGLProgram {
		const gl = this.gl,
			program = allocated(gl.createProgram());
		try {
			for (const [type, source] of [
				[gl.VERTEX_SHADER, vertex],
				[gl.FRAGMENT_SHADER, fragment],
			] as const) {
				const shader = allocated(gl.createShader(type));
				gl.shaderSource(shader, source);
				gl.compileShader(shader);
				if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
					const reason = gl.getShaderInfoLog(shader);
					gl.deleteShader(shader);
					throw new Error(reason || "Orbit shader compilation failed");
				}
				gl.attachShader(program, shader);
				gl.deleteShader(shader);
			}
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS))
				throw new Error(
					gl.getProgramInfoLog(program) || "Orbit shader linking failed",
				);
			return program;
		} catch (error) {
			gl.deleteProgram(program);
			throw error;
		}
	}

	private attributes(layout: [number, number, number][], stride: number): void {
		for (const [index, size, offset] of layout) {
			this.gl.enableVertexAttribArray(index);
			this.gl.vertexAttribPointer(
				index,
				size,
				this.gl.FLOAT,
				false,
				stride,
				offset,
			);
		}
	}

	private uniform(
		program: WebGLProgram,
		name: string,
	): WebGLUniformLocation | null {
		let cache = this.uniforms.get(program);
		if (!cache) {
			cache = new Map();
			this.uniforms.set(program, cache);
		}
		if (!cache.has(name))
			cache.set(name, this.gl.getUniformLocation(program, name));
		return cache.get(name) ?? null;
	}

	mesh(builder: MeshBuilder): OrbitMesh {
		const gl = this.gl,
			vao = allocated(gl.createVertexArray());
		let buf: WebGLBuffer;
		try {
			buf = allocated(gl.createBuffer());
		} catch (error) {
			gl.deleteVertexArray(vao);
			throw error;
		}
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(builder.v), gl.STATIC_DRAW);
		this.attributes(
			[
				[0, 3, 0],
				[1, 3, 12],
				[2, 3, 24],
				[3, 1, 36],
			],
			40,
		);
		gl.bindVertexArray(null);
		const mesh = { vao, buf, count: builder.v.length / 10 };
		this.meshes.add(mesh);
		return mesh;
	}

	dispose(mesh: OrbitMesh): void {
		if (!this.meshes.delete(mesh)) return;
		this.gl.deleteBuffer(mesh.buf);
		this.gl.deleteVertexArray(mesh.vao);
	}

	resize(): void {
		const bounds = this.canvas.getBoundingClientRect();
		this.w = Math.max(1, bounds.width);
		this.h = Math.max(1, bounds.height);
		this.dpr = Math.min(window.devicePixelRatio || 1, 1.65);
		const width = Math.round(this.w * this.dpr),
			height = Math.round(this.h * this.dpr);
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		this.gl.viewport(0, 0, width, height);
	}

	begin(eye: Vec3, target: Vec3): void {
		const gl = this.gl;
		this.eye = eye;
		this.vp = M.mul(
			M.perspective((40 * Math.PI) / 180, this.w / this.h, 0.5, 650),
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
		mesh: OrbitMesh,
		{
			offset = [0, 0, 0],
			opacity = 1,
			dim = 1,
		}: { offset?: Vec3; opacity?: number; dim?: number } = {},
	): void {
		const gl = this.gl,
			program = this.program;
		gl.useProgram(program);
		gl.uniformMatrix4fv(this.uniform(program, "uVP"), false, this.vp);
		gl.uniform3fv(this.uniform(program, "uOffset"), offset);
		gl.uniform3fv(this.uniform(program, "uEye"), this.eye);
		gl.uniform3fv(this.uniform(program, "uFog"), this.fog);
		gl.uniform1f(this.uniform(program, "uOpacity"), opacity);
		gl.uniform1f(this.uniform(program, "uDim"), dim);
		gl.bindVertexArray(mesh.vao);
		gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
	}

	particles(vertices: number[]): void {
		if (!vertices.length) return;
		const gl = this.gl,
			program = this.particleProgram;
		gl.useProgram(program);
		gl.uniformMatrix4fv(this.uniform(program, "uVP"), false, this.vp);
		gl.uniform1f(this.uniform(program, "uDPR"), this.dpr);
		gl.bindVertexArray(this.particleVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
		gl.depthMask(false);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
		gl.drawArrays(gl.POINTS, 0, vertices.length / 7);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(true);
	}

	project(point: Vec3): {
		x: number;
		y: number;
		depth: number;
		visible: boolean;
	} {
		const q = [0, 1, 2, 3].map(
			(row) =>
				this.vp[row] * point[0] +
				this.vp[4 + row] * point[1] +
				this.vp[8 + row] * point[2] +
				this.vp[12 + row],
		);
		return {
			x: ((q[0] / q[3]) * 0.5 + 0.5) * this.w,
			y: ((-0.5 * q[1]) / q[3] + 0.5) * this.h,
			depth: q[3],
			visible: q[3] > 0 && q[2] / q[3] < 1,
		};
	}

	destroy(): void {
		for (const mesh of this.meshes) this.dispose(mesh);
		this.gl.deleteBuffer(this.particleBuffer);
		this.gl.deleteVertexArray(this.particleVao);
		this.gl.deleteProgram(this.program);
		this.gl.deleteProgram(this.particleProgram);
		this.uniforms.clear();
	}
}
