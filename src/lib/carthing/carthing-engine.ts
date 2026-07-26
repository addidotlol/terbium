export type FlashTarget =
	'preset1' | 'preset2' | 'preset3' | 'preset4' | 'settings' | 'back' | 'usb' | 'dial' | 'tag';

export type ViewName = 'front' | 'screen' | 'back' | 'keys' | 'dial' | 'usb';

export type RGB = [number, number, number];
export type Color = string | RGB;

export interface ViewSpec {
	yaw: number;
	pitch: number;
	dist?: number;
}

export interface FlashOptions {
	duration?: number;
	flashes?: number;
	infinite?: boolean;
}

export interface PanOptions {
	duration?: number;
}

export interface SpinOptions {
	turns?: number;
	duration?: number;
	infinite?: boolean;
	speed?: number;
}

export interface ScreenRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface EngineOptions {
	interactive?: boolean;
	defaultUi?: boolean;
}

export type ScreenDrawFn = (ctx: CanvasRenderingContext2D, lcd: ScreenRect) => void;

type Pt = [number, number];

interface Mesh {
	posBuf: WebGLBuffer;
	nrmBuf: WebGLBuffer;
	count: number;
}

interface FlashState {
	color: RGB;
	t0: number;
	period: number;
	end: number;
}

interface CamState {
	yaw: number;
	pitch: number;
	dist: number;
}

interface CamTween {
	t0: number;
	duration: number;
	from: CamState;
	to: CamState;
}

type SpinState =
	| { infinite: true; speed: number }
	| { infinite?: false; t0: number; duration: number; from: number; to: number };

const BODY_W = 116.8,
	BODY_H = 63.5,
	BODY_D = 4.8;
const DIAL_R = 18,
	DIAL_X = 47.6,
	DIAL_Y = 9,
	DIAL_D = 9.5;
const GLASS_W = 114.8,
	GLASS_H = 61.5,
	GLASS_Z = BODY_D / 2 + 0.1;
const KEYS = { first: -46, last: 46, roll: 0.2, corner: 5, pd: 0.5, pr: 0.4, pw: 4.5 };
const BACK = { w: 45, h: 63.6, rise: 4, fadeLR: 4, slopeTB: 15, bow: 0, cy: 0 };
const BACK_PIN = 38;
const PZ_OUT = BODY_D / 2 - 0.13;
const PZ_IN = Math.min(2.2, PZ_OUT - 0.07);
const LCD: ScreenRect = { x: 43, y: 39, w: 691, h: 426 };
const UI_W = 918,
	UI_H = 492;

const VIEWS: Record<ViewName, Required<ViewSpec>> = {
	front: { yaw: -0.35, pitch: 0.15, dist: 230 },
	screen: { yaw: 0, pitch: 0, dist: 190 },
	back: { yaw: Math.PI - 0.25, pitch: 0.3, dist: 230 },
	keys: { yaw: 0.02, pitch: 1.2, dist: 180 },
	dial: { yaw: -0.6, pitch: 0.2, dist: 150 },
	usb: { yaw: Math.PI - 0.8, pitch: 0.25, dist: 150 }
};

const LIT_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMVP;
uniform mat3 uNrm;
varying vec3 vN;
void main() {
  vN = uNrm * aNrm;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const LIT_FS = `
precision mediump float;
varying vec3 vN;
uniform vec3 uColor;
uniform float uGloss;
void main() {
  vec3 n = normalize(vN);
  vec3 key = normalize(vec3(0.45, 0.65, 0.62));
  vec3 fill = normalize(vec3(-0.6, -0.15, 0.45));
  float d = max(dot(n, key), 0.0) * 0.85 + max(dot(n, fill), 0.0) * 0.3;
  float hemi = 0.28 + 0.14 * (n.y * 0.5 + 0.5);
  vec3 h = normalize(key + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 48.0) * uGloss;
  vec3 c = uColor * (d + hemi) + vec3(spec);
  gl_FragColor = vec4(c, 1.0);
}`;

const TEX_VS = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uMVP;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const TEX_FS = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

function mat4Identity(): Float32Array {
	return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
	const o = new Float32Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			o[c * 4 + r] =
				a[r] * b[c * 4] +
				a[4 + r] * b[c * 4 + 1] +
				a[8 + r] * b[c * 4 + 2] +
				a[12 + r] * b[c * 4 + 3];
		}
	return o;
}
function mat4Perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
	const f = 1 / Math.tan(fov / 2);
	const o = new Float32Array(16);
	o[0] = f / aspect;
	o[5] = f;
	o[10] = (far + near) / (near - far);
	o[11] = -1;
	o[14] = (2 * far * near) / (near - far);
	return o;
}
function mat4Translate(x: number, y: number, z: number): Float32Array {
	const o = mat4Identity();
	o[12] = x;
	o[13] = y;
	o[14] = z;
	return o;
}
function mat4RotX(a: number): Float32Array {
	const c = Math.cos(a),
		s = Math.sin(a);
	return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
function mat4RotY(a: number): Float32Array {
	const c = Math.cos(a),
		s = Math.sin(a);
	return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
function mat4RotZ(a: number): Float32Array {
	const c = Math.cos(a),
		s = Math.sin(a);
	return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function mat3FromMat4(m: Float32Array): Float32Array {
	return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

function roundedRectProfile(w: number, h: number, r: number, seg: number): Pt[] {
	const pts: Pt[] = [];
	r = Math.min(r, w / 2 - 0.01, h / 2 - 0.01);
	const cx = w / 2 - r,
		cy = h / 2 - r;
	const corners: Array<[number, number, number]> = [
		[cx, cy, 0],
		[-cx, cy, 90],
		[-cx, -cy, 180],
		[cx, -cy, 270]
	];
	for (const [x, y, start] of corners) {
		for (let i = 0; i <= seg; i++) {
			const a = ((start + (i / seg) * 90) * Math.PI) / 180;
			pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
		}
	}
	return pts;
}
function circleProfile(r: number, seg: number): Pt[] {
	const pts: Pt[] = [];
	for (let i = 0; i < seg; i++) {
		const a = (i / seg) * Math.PI * 2;
		pts.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return pts;
}
function bowedProfile(w: number, h: number, bow: number, seg: number): Pt[] {
	const pts: Pt[] = [];
	const hs = h / 2 - bow;
	pts.push([w / 2, -hs], [w / 2, hs]);
	for (let i = 1; i < seg; i++) {
		const x = w / 2 - (i / seg) * w;
		pts.push([x, h / 2 - bow * Math.pow((2 * x) / w, 2)]);
	}
	pts.push([-w / 2, hs], [-w / 2, -hs]);
	for (let i = 1; i < seg; i++) {
		const x = -w / 2 + (i / seg) * w;
		pts.push([x, -h / 2 + bow * Math.pow((2 * x) / w, 2)]);
	}
	return pts;
}
function fanCap(profile: Pt[], z: number, flip: boolean): number[] {
	const pos: number[] = [];
	let cx = 0,
		cy = 0;
	for (const p of profile) {
		cx += p[0];
		cy += p[1];
	}
	cx /= profile.length;
	cy /= profile.length;
	const n = profile.length;
	for (let i = 0; i < n; i++) {
		const a = profile[i],
			b = profile[(i + 1) % n];
		if (flip) pos.push(cx, cy, z, b[0], b[1], z, a[0], a[1], z);
		else pos.push(cx, cy, z, a[0], a[1], z, b[0], b[1], z);
	}
	return pos;
}
function ring(pFront: Pt[], zFront: number, pBack: Pt[], zBack: number): number[] {
	const pos: number[] = [];
	const n = pFront.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const a = pFront[i],
			a2 = pFront[j],
			b = pBack[i],
			b2 = pBack[j];
		pos.push(b[0], b[1], zBack, b2[0], b2[1], zBack, a2[0], a2[1], zFront);
		pos.push(b[0], b[1], zBack, a2[0], a2[1], zFront, a[0], a[1], zFront);
	}
	return pos;
}
function roundedSolid(
	makeProfile: (inset: number) => Pt[],
	d: number,
	r: number,
	steps: number,
	extraZ?: number[]
): number[] {
	const rings: Array<[Pt[], number]> = [];
	for (let i = 0; i <= steps; i++) {
		const th = ((1 - i / steps) * Math.PI) / 2;
		rings.push([makeProfile(r * (1 - Math.cos(th))), d / 2 - r + r * Math.sin(th)]);
	}
	if (extraZ) for (const ez of extraZ) rings.push([makeProfile(0), ez]);
	rings.push([makeProfile(0), -(d / 2 - r)]);
	for (let i = 1; i <= steps; i++) {
		const th = ((i / steps) * Math.PI) / 2;
		rings.push([makeProfile(r * (1 - Math.cos(th))), -(d / 2 - r) - r * Math.sin(th)]);
	}
	let pos = fanCap(rings[0][0], d / 2, false);
	for (let i = 0; i < rings.length - 1; i++) {
		pos = pos.concat(ring(rings[i][0], rings[i][1], rings[i + 1][0], rings[i + 1][1]));
	}
	return pos.concat(fanCap(rings[rings.length - 1][0], -d / 2, true));
}
function extrude(profile: Pt[], depth: number): number[] {
	return fanCap(profile, depth / 2, false)
		.concat(ring(profile, depth / 2, profile, -depth / 2))
		.concat(fanCap(profile, -depth / 2, true));
}
function transform(
	pos: number[],
	fn: (x: number, y: number, z: number) => [number, number, number]
): number[] {
	for (let i = 0; i < pos.length; i += 3) {
		const [x, y, z] = fn(pos[i], pos[i + 1], pos[i + 2]);
		pos[i] = x;
		pos[i + 1] = y;
		pos[i + 2] = z;
	}
	return pos;
}
function flatNormals(pos: number[]): Float32Array {
	const nrm = new Float32Array(pos.length);
	for (let i = 0; i < pos.length; i += 9) {
		const ax = pos[i],
			ay = pos[i + 1],
			az = pos[i + 2];
		const bx = pos[i + 3],
			by = pos[i + 4],
			bz = pos[i + 5];
		const cx2 = pos[i + 6],
			cy2 = pos[i + 7],
			cz = pos[i + 8];
		const ux = bx - ax,
			uy = by - ay,
			uz = bz - az;
		const vx = cx2 - ax,
			vy = cy2 - ay,
			vz = cz - az;
		let nx = uy * vz - uz * vy,
			ny = uz * vx - ux * vz,
			nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz) || 1;
		nx /= len;
		ny /= len;
		nz /= len;
		for (let k = 0; k < 3; k++) {
			nrm[i + k * 3] = nx;
			nrm[i + k * 3 + 1] = ny;
			nrm[i + k * 3 + 2] = nz;
		}
	}
	return nrm;
}
function smoothNormals(pos: number[], limitDot: number): Float32Array {
	const flat = flatNormals(pos);
	const map = new Map<string, number[]>();
	for (let i = 0; i < pos.length; i += 3) {
		const k = pos[i].toFixed(2) + ',' + pos[i + 1].toFixed(2) + ',' + pos[i + 2].toFixed(2);
		let bucket = map.get(k);
		if (!bucket) {
			bucket = [];
			map.set(k, bucket);
		}
		bucket.push(i);
	}
	const out = new Float32Array(flat.length);
	for (const idxs of map.values()) {
		for (const i of idxs) {
			if (flat[i + 2] < -0.999) {
				out[i] = flat[i];
				out[i + 1] = flat[i + 1];
				out[i + 2] = flat[i + 2];
				continue;
			}
			let nx = 0,
				ny = 0,
				nz = 0;
			for (const j of idxs) {
				const d = flat[i] * flat[j] + flat[i + 1] * flat[j + 1] + flat[i + 2] * flat[j + 2];
				if (d > limitDot) {
					nx += flat[j];
					ny += flat[j + 1];
					nz += flat[j + 2];
				}
			}
			const l = Math.hypot(nx, ny, nz) || 1;
			out[i] = nx / l;
			out[i + 1] = ny / l;
			out[i + 2] = nz / l;
		}
	}
	return out;
}
function subdividedProfileMaker(
	makeProfile: (inset: number) => Pt[],
	maxLen: number | ((a: Pt, b: Pt) => number)
): (inset: number) => Pt[] {
	const base = makeProfile(0);
	const lenFor = typeof maxLen === 'function' ? maxLen : () => maxLen;
	const kArr = base.map((p, i) => {
		const q = base[(i + 1) % base.length];
		return Math.max(
			1,
			Math.min(320, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / lenFor(p, q)))
		);
	});
	return (inset: number) => {
		const raw = makeProfile(inset);
		const out: Pt[] = [];
		for (let j = 0; j < raw.length; j++) {
			const a = raw[j],
				b = raw[(j + 1) % raw.length];
			for (let m = 0; m < kArr[j]; m++) {
				out.push([a[0] + ((b[0] - a[0]) * m) / kArr[j], a[1] + ((b[1] - a[1]) * m) / kArr[j]]);
			}
		}
		return out;
	};
}
function pocketDeform(x: number, y: number, z: number): [number, number, number] {
	const floor = BODY_H / 2 - KEYS.pd;
	const d = Math.abs(x - KEYS.last);
	if (Math.abs(z) <= (PZ_IN + PZ_OUT) / 2 && y > floor && d < KEYS.pw + KEYS.pr) {
		const rise =
			d <= KEYS.pw ? 0 : KEYS.pd * (1 - Math.cos(((Math.PI / 2) * (d - KEYS.pw)) / KEYS.pr));
		y = Math.min(y, floor + rise);
	}
	return [x, y, z];
}
function humpMesh(
	W: number,
	H: number,
	R: number,
	rampX: number,
	rampY: number,
	rise: number
): number[] {
	const S = 12,
		NOTCH = 5.5;
	const xNotch = -W / 2 + rampX;
	function ringProfile(t: number): { prof: Pt[]; z: number } {
		const d01 = Math.sin((Math.PI * t) / 2);
		const ix = rampX * (1 - Math.pow(1 - d01, 3));
		const iy = rampY * t;
		const raw = bowedProfile(W - 2 * ix, H - 2 * iy, R, 16);
		const xFoot = -(W - 2 * ix) / 2;
		const out: Pt[] = [];
		for (let i = 0; i < raw.length; i++) {
			const p = raw[i],
				q = raw[(i + 1) % raw.length];
			out.push(p);
			const pWall = Math.abs(p[0] - xFoot) < 0.001,
				qWall = Math.abs(q[0] - xFoot) < 0.001;
			if (pWall && qWall && p[1] > q[1]) {
				if (p[1] > NOTCH && q[1] < NOTCH)
					out.push([xFoot, NOTCH], [Math.max(xFoot, xNotch), NOTCH]);
				if (p[1] > -NOTCH && q[1] < -NOTCH)
					out.push([Math.max(xFoot, xNotch), -NOTCH], [xFoot, -NOTCH]);
			}
		}
		return { prof: out, z: -(BODY_D / 2 - 0.1) - rise * d01 };
	}
	let pos: number[] = [];
	let prev: { prof: Pt[]; z: number } | null = null;
	for (let s = 0; s <= S; s++) {
		const cur = ringProfile(s / S);
		if (prev) pos = pos.concat(ring(prev.prof, prev.z, cur.prof, cur.z));
		prev = cur;
	}
	return pos.concat(fanCap(prev!.prof, prev!.z, true));
}
function backTopZ(): number {
	return -(BODY_D / 2 - 0.1) - BACK.rise;
}
function parseColor(c: Color): RGB {
	if (Array.isArray(c)) return c;
	let h = c.replace('#', '');
	if (h.length === 3)
		h = h
			.split('')
			.map((ch) => ch + ch)
			.join('');
	return [
		parseInt(h.slice(0, 2), 16) / 255,
		parseInt(h.slice(2, 4), 16) / 255,
		parseInt(h.slice(4, 6), 16) / 255
	];
}
function easeInOut(u: number): number {
	return u * u * (3 - 2 * u);
}

interface LitLocations {
	aPos: number;
	aNrm: number;
	uMVP: WebGLUniformLocation | null;
	uNrm: WebGLUniformLocation | null;
	uColor: WebGLUniformLocation | null;
	uGloss: WebGLUniformLocation | null;
}

interface TexLocations {
	aPos: number;
	aUV: number;
	uMVP: WebGLUniformLocation | null;
	uTex: WebGLUniformLocation | null;
}

export class CarThingEngine {
	yaw: number;
	pitch: number;
	dist: number;

	private _canvas: HTMLCanvasElement;
	private _gl: WebGLRenderingContext;
	private _defaultUi: boolean;
	private _playing: boolean;
	private _flashes = new Map<FlashTarget, FlashState>();
	private _camTween: CamTween | null = null;
	private _spin: SpinState | null = null;
	private _dialAngle = 0;
	private _destroyed = false;
	private _listeners: Array<[EventTarget, string, EventListener]> = [];
	private _litProg: WebGLProgram;
	private _texProg: WebGLProgram;
	private _litLoc: LitLocations;
	private _texLoc: TexLocations;
	private _body: Mesh;
	private _dial: Mesh;
	private _dialDot: Mesh;
	private _backBtn: Mesh;
	private _edgeTab: Mesh;
	private _hump: Mesh;
	private _slot: Mesh;
	private _keys: Mesh[];
	private _mics: Mesh[];
	private _screenPosBuf: WebGLBuffer;
	private _screenUVBuf: WebGLBuffer;
	private _screenVerts: number;
	private _ui: HTMLCanvasElement;
	private _ctx: CanvasRenderingContext2D;
	private _track = { title: 'Nightcall', artist: 'Kavinsky', duration: 258 };
	private _progress = 74;
	private _tex: WebGLTexture;
	private _baseColors: Record<string, RGB>;
	private _velYaw = 0;
	private _velPitch = 0;
	private _dragging = false;
	private _prevT = 0;
	private _lastUiUpdate = 0;
	private _raf: number;

	constructor(canvas: HTMLCanvasElement, opts: EngineOptions = {}) {
		const interactive = opts.interactive !== false;
		const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
		if (!gl) throw new Error('WebGL unavailable');
		this._canvas = canvas;
		this._gl = gl;
		this._defaultUi = opts.defaultUi !== false;
		this._playing = this._defaultUi && !matchMedia('(prefers-reduced-motion: reduce)').matches;

		const compile = (type: number, src: string): WebGLShader => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			return s;
		};
		const program = (vs: string, fs: string): WebGLProgram => {
			const p = gl.createProgram()!;
			gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
			gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
			gl.linkProgram(p);
			return p;
		};
		this._litProg = program(LIT_VS, LIT_FS);
		this._texProg = program(TEX_VS, TEX_FS);
		this._litLoc = {
			aPos: gl.getAttribLocation(this._litProg, 'aPos'),
			aNrm: gl.getAttribLocation(this._litProg, 'aNrm'),
			uMVP: gl.getUniformLocation(this._litProg, 'uMVP'),
			uNrm: gl.getUniformLocation(this._litProg, 'uNrm'),
			uColor: gl.getUniformLocation(this._litProg, 'uColor'),
			uGloss: gl.getUniformLocation(this._litProg, 'uGloss')
		};
		this._texLoc = {
			aPos: gl.getAttribLocation(this._texProg, 'aPos'),
			aUV: gl.getAttribLocation(this._texProg, 'aUV'),
			uMVP: gl.getUniformLocation(this._texProg, 'uMVP'),
			uTex: gl.getUniformLocation(this._texProg, 'uTex')
		};

		const uploadMesh = (pos: number[], nrm: Float32Array): Mesh => {
			const posBuf = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
			const nrmBuf = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
			gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
			return { posBuf, nrmBuf, count: pos.length / 3 };
		};
		const makeMesh = (pos: number[]): Mesh => uploadMesh(pos, flatNormals(pos));
		const makeMeshSmooth = (pos: number[], limitDot: number): Mesh =>
			uploadMesh(pos, smoothNormals(pos, limitDot));

		this._body = makeMesh(
			transform(
				roundedSolid(
					subdividedProfileMaker(
						(i) =>
							roundedRectProfile(
								BODY_W - 2 * i,
								BODY_H - 2 * i,
								Math.max(KEYS.corner - i, 0.5),
								10
							),
						(a, b) => (a[1] > 28 && b[1] > 28 ? 0.4 : 2)
					),
					BODY_D,
					KEYS.roll,
					4,
					[PZ_OUT, PZ_IN, -PZ_IN, -PZ_OUT]
				),
				(x, y, z) => pocketDeform(x, y, z)
			)
		);
		this._dial = makeMesh(roundedSolid((i) => circleProfile(DIAL_R - i, 96), DIAL_D, 3, 5));
		this._dialDot = makeMesh(extrude(circleProfile(1.5, 16), 0.3));
		this._backBtn = makeMesh(roundedSolid((i) => circleProfile(6 - i, 48), 4, 1.8, 4));
		this._edgeTab = makeMesh(
			transform(
				roundedSolid(
					(i) => roundedRectProfile(6.5 - 2 * i, 10.5 - 2 * i, Math.max(1 - i, 0.05), 6),
					2.4,
					0.6,
					3
				),
				(x, y, z) => [x - BODY_W / 2 + 0.2, y + 18, z]
			)
		);

		const wallX = BACK_PIN - BACK.w - BACK.fadeLR;
		const wallV = wallX + BACK.fadeLR;
		const wallZMid = (backTopZ() - (BODY_D / 2 - 0.1)) / 2;
		this._hump = makeMeshSmooth(
			transform(
				humpMesh(BACK.w + 2 * BACK.fadeLR, BACK.h, BACK.bow, BACK.fadeLR, BACK.slopeTB, BACK.rise),
				(x, y, z) => [x + BACK_PIN - BACK.w / 2, y + BACK.cy, z]
			),
			0.9
		);
		this._slot = makeMesh(
			transform(extrude(roundedRectProfile(7.4, 2.3, 1.15, 8), 0.3), (x, y, z) => [
				wallV - 0.1 - z,
				-x,
				y + wallZMid - 0.15
			])
		);

		const pitch = (KEYS.last - KEYS.first) / 4;
		this._keys = [];
		for (let k = 0; k < 4; k++) {
			this._keys.push(
				makeMesh(
					transform(
						roundedSolid(
							(i) => roundedRectProfile(11 - 2 * i, 2.6 - 2 * i, 1.2 - i, 4),
							1.8,
							0.6,
							3
						),
						(x, y, z) => [x + KEYS.first + k * pitch, z + BODY_H / 2, -y]
					)
				)
			);
		}
		this._keys.push(
			makeMesh(
				transform(
					roundedSolid((i) => roundedRectProfile(9 - 2 * i, 2.6 - 2 * i, 1.2 - i, 4), 2.6, 0.8, 3),
					(x, y, z) => [x + KEYS.last, z + BODY_H / 2 - 1.3, -y]
				)
			)
		);
		this._mics = [];
		for (let k = 0; k < 4; k++) {
			this._mics.push(
				makeMesh(
					transform(extrude(circleProfile(0.6, 10), 0.5), (x, y, z) => [
						x + KEYS.first + (k + 0.5) * pitch,
						z + BODY_H / 2 - 0.24,
						-y
					])
				)
			);
		}

		const glassProfile = roundedRectProfile(GLASS_W, GLASS_H, 3.5, 10);
		const screenPosArr: number[] = [],
			screenUVArr: number[] = [];
		for (let i = 0; i < glassProfile.length; i++) {
			const a = glassProfile[i],
				b = glassProfile[(i + 1) % glassProfile.length];
			for (const p of [[0, 0] as Pt, a, b]) {
				screenPosArr.push(p[0], p[1], GLASS_Z);
				screenUVArr.push(p[0] / GLASS_W + 0.5, p[1] / GLASS_H + 0.5);
			}
		}
		this._screenVerts = screenPosArr.length / 3;
		this._screenPosBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenPosBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(screenPosArr), gl.STATIC_DRAW);
		this._screenUVBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenUVBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(screenUVArr), gl.STATIC_DRAW);

		this._ui = document.createElement('canvas');
		this._ui.width = UI_W;
		this._ui.height = UI_H;
		this._ctx = this._ui.getContext('2d')!;
		this._tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this._tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		if (this._defaultUi) this._drawDefaultUi();
		else this._clearScreen();
		this.updateScreen();

		this._baseColors = {
			body: [0.082, 0.084, 0.088],
			hump: [0.082, 0.084, 0.088],
			slot: [0.015, 0.015, 0.017],
			tab: [0.075, 0.077, 0.081],
			key: [0.095, 0.098, 0.102],
			mic: [0.015, 0.015, 0.016],
			dial: [0.068, 0.07, 0.073],
			back: [0.075, 0.077, 0.08]
		};

		this.yaw = VIEWS.front.yaw;
		this.pitch = VIEWS.front.pitch;
		this.dist = VIEWS.front.dist;

		if (interactive) {
			let lastX = 0,
				lastY = 0;
			const on = <K extends keyof HTMLElementEventMap>(
				el: HTMLElement,
				ev: K,
				fn: (e: HTMLElementEventMap[K]) => void,
				opts2?: AddEventListenerOptions
			) => {
				el.addEventListener(ev, fn as EventListener, opts2);
				this._listeners.push([el, ev, fn as EventListener]);
			};
			on(canvas, 'pointerdown', (e) => {
				this._dragging = true;
				this._camTween = null;
				lastX = e.clientX;
				lastY = e.clientY;
				canvas.setPointerCapture(e.pointerId);
			});
			on(canvas, 'pointermove', (e) => {
				if (!this._dragging) return;
				const dx = e.clientX - lastX,
					dy = e.clientY - lastY;
				lastX = e.clientX;
				lastY = e.clientY;
				this.yaw += dx * 0.008;
				this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.008));
				this._velYaw = dx * 0.008;
				this._velPitch = dy * 0.008;
			});
			on(canvas, 'pointerup', () => {
				this._dragging = false;
			});
			on(canvas, 'pointercancel', () => {
				this._dragging = false;
			});
			on(
				canvas,
				'wheel',
				(e) => {
					e.preventDefault();
					this._camTween = null;
					this.dist = Math.max(120, Math.min(500, this.dist + e.deltaY * 0.35));
				},
				{ passive: false }
			);
		}

		const frame = (t: number) => {
			if (this._destroyed) return;
			this._raf = requestAnimationFrame(frame);
			this._frame(t);
		};
		this._raf = requestAnimationFrame(frame);
	}

	flash(target: FlashTarget, color: Color, opts: FlashOptions = {}): void {
		const duration = opts.duration ?? 900;
		const flashes = opts.flashes ?? 2;
		const t0 = performance.now();
		this._flashes.set(target, {
			color: parseColor(color),
			t0,
			period: opts.infinite ? (opts.duration ?? 900) : duration / flashes,
			end: opts.infinite ? Infinity : t0 + duration
		});
	}

	stopFlash(target: FlashTarget): void {
		const f = this._flashes.get(target);
		if (!f) return;
		const now = performance.now();
		f.end = f.t0 + Math.ceil((now - f.t0) / f.period) * f.period;
	}

	panTo(view: ViewName | ViewSpec, opts: PanOptions = {}): void {
		const target = typeof view === 'string' ? VIEWS[view] : view;
		if (!target) throw new Error('unknown view: ' + String(view));
		let dYaw = (target.yaw - this.yaw) % (Math.PI * 2);
		if (dYaw > Math.PI) dYaw -= Math.PI * 2;
		if (dYaw < -Math.PI) dYaw += Math.PI * 2;
		this._camTween = {
			t0: performance.now(),
			duration: opts.duration ?? 850,
			from: { yaw: this.yaw, pitch: this.pitch, dist: this.dist },
			to: { yaw: this.yaw + dYaw, pitch: target.pitch, dist: target.dist ?? this.dist }
		};
	}

	setView(yaw: number, pitch: number, dist?: number): void {
		this._camTween = null;
		this.yaw = yaw;
		this.pitch = pitch;
		if (dist) this.dist = dist;
	}

	spinDial(direction: 'cw' | 'ccw' = 'cw', opts: SpinOptions = {}): void {
		const sign = direction === 'ccw' ? 1 : -1;
		const start = direction === 'ccw' ? -Math.PI / 2 : Math.PI / 2;
		this._dialAngle = start;
		if (opts.infinite) {
			this._spin = { infinite: true, speed: sign * (opts.speed ?? 0.55) * Math.PI * 2 };
			return;
		}
		const turns = opts.turns ?? 1;
		this._spin = {
			t0: performance.now(),
			duration: opts.duration ?? 1100 * turns,
			from: start,
			to: start + sign * turns * Math.PI * 2
		};
	}

	stopSpin(): void {
		this._spin = null;
	}

	screen(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; lcd: ScreenRect } {
		return { canvas: this._ui, ctx: this._ctx, lcd: { ...LCD } };
	}

	updateScreen(): void {
		const gl = this._gl;
		gl.bindTexture(gl.TEXTURE_2D, this._tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._ui);
	}

	setScreenDraw(fn: ScreenDrawFn): void {
		this._defaultUi = false;
		this._clearScreen();
		fn(this._ctx, { ...LCD });
		this.updateScreen();
	}

	setScreenImage(src: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => {
				this.setScreenDraw((ctx, lcd) => {
					const scale = Math.max(lcd.w / img.width, lcd.h / img.height);
					const w = img.width * scale,
						h = img.height * scale;
					ctx.save();
					ctx.beginPath();
					ctx.rect(lcd.x, lcd.y, lcd.w, lcd.h);
					ctx.clip();
					ctx.drawImage(img, lcd.x + (lcd.w - w) / 2, lcd.y + (lcd.h - h) / 2, w, h);
					ctx.restore();
				});
				resolve();
			};
			img.onerror = reject;
			img.src = src;
		});
	}

	setDefaultUi(on: boolean): void {
		this._defaultUi = on;
		this._playing = on;
		if (on) {
			this._drawDefaultUi();
			this.updateScreen();
		}
	}

	destroy(): void {
		this._destroyed = true;
		cancelAnimationFrame(this._raf);
		for (const [el, ev, fn] of this._listeners) el.removeEventListener(ev, fn);
		const ext = this._gl.getExtension('WEBGL_lose_context');
		if (ext) ext.loseContext();
	}

	private _flashColor(target: FlashTarget, base: RGB): RGB {
		const f = this._flashes.get(target);
		if (!f) return base;
		const now = performance.now();
		if (now >= f.end) {
			this._flashes.delete(target);
			return base;
		}
		const k = Math.pow(Math.sin((Math.PI * (now - f.t0)) / f.period), 2);
		return [
			base[0] + (f.color[0] - base[0]) * k,
			base[1] + (f.color[1] - base[1]) * k,
			base[2] + (f.color[2] - base[2]) * k
		];
	}

	private _clearScreen(): void {
		const ctx = this._ctx;
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, UI_W, UI_H);
		ctx.fillStyle = '#0d0d0f';
		ctx.fillRect(LCD.x, LCD.y, LCD.w, LCD.h);
	}

	private _drawDefaultUi(): void {
		const ctx = this._ctx;
		this._clearScreen();
		ctx.save();
		ctx.translate(LCD.x - 32, LCD.y - 27);
		const artS = 250,
			artX = 76,
			artY = 96;
		ctx.save();
		ctx.beginPath();
		ctx.roundRect(artX, artY, artS, artS, 8);
		ctx.clip();
		const g = ctx.createLinearGradient(artX, artY, artX, artY + artS);
		g.addColorStop(0, '#10102e');
		g.addColorStop(0.65, '#3a1140');
		g.addColorStop(1, '#0c0c1c');
		ctx.fillStyle = g;
		ctx.fillRect(artX, artY, artS, artS);
		const sun = ctx.createLinearGradient(artX, artY + artS * 0.25, artX, artY + artS * 0.8);
		sun.addColorStop(0, '#ff5d73');
		sun.addColorStop(1, '#b3123f');
		ctx.fillStyle = sun;
		ctx.beginPath();
		ctx.arc(artX + artS / 2, artY + artS * 0.52, artS * 0.27, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = '#10102e';
		for (let k = 0; k < 4; k++) {
			ctx.fillRect(artX, artY + artS * (0.52 + k * 0.055), artS, artS * 0.014 + k * 0.6);
		}
		ctx.restore();
		const colX = artX + artS + 40;
		ctx.textAlign = 'left';
		ctx.fillStyle = '#1db954';
		ctx.font = '600 17px system-ui';
		ctx.fillText('Now playing', colX, 150);
		ctx.fillStyle = '#ffffff';
		ctx.font = '700 46px system-ui';
		ctx.fillText(this._track.title, colX, 205);
		ctx.fillStyle = '#b3b3b3';
		ctx.font = '400 26px system-ui';
		ctx.fillText(this._track.artist, colX, 245);
		const px0 = artX,
			px1 = LCD.x + LCD.w - 60,
			pyLine = 372;
		ctx.strokeStyle = '#3a3a3a';
		ctx.lineWidth = 3;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(px0, pyLine);
		ctx.lineTo(px1, pyLine);
		ctx.stroke();
		const head = px0 + (px1 - px0) * (this._progress / this._track.duration);
		ctx.strokeStyle = '#ffffff';
		ctx.beginPath();
		ctx.moveTo(px0, pyLine);
		ctx.lineTo(head, pyLine);
		ctx.stroke();
		const rowY = 412,
			iconC = '#e8eef0';
		ctx.strokeStyle = iconC;
		ctx.fillStyle = iconC;
		ctx.lineWidth = 3;
		const shX = artX + 12;
		ctx.beginPath();
		ctx.moveTo(shX - 14, rowY - 9);
		ctx.lineTo(shX + 10, rowY + 9);
		ctx.moveTo(shX - 14, rowY + 9);
		ctx.lineTo(shX + 10, rowY - 9);
		ctx.stroke();
		const prevX = 262;
		ctx.fillRect(prevX - 14, rowY - 13, 4, 26);
		ctx.beginPath();
		ctx.moveTo(prevX + 14, rowY - 13);
		ctx.lineTo(prevX - 8, rowY);
		ctx.lineTo(prevX + 14, rowY + 13);
		ctx.closePath();
		ctx.fill();
		const midX = 400;
		if (this._playing) {
			ctx.fillRect(midX - 12, rowY - 15, 8, 30);
			ctx.fillRect(midX + 4, rowY - 15, 8, 30);
		} else {
			ctx.beginPath();
			ctx.moveTo(midX - 10, rowY - 15);
			ctx.lineTo(midX + 15, rowY);
			ctx.lineTo(midX - 10, rowY + 15);
			ctx.closePath();
			ctx.fill();
		}
		const nextX = 538;
		ctx.fillRect(nextX + 10, rowY - 13, 4, 26);
		ctx.beginPath();
		ctx.moveTo(nextX - 14, rowY - 13);
		ctx.lineTo(nextX + 8, rowY);
		ctx.lineTo(nextX - 14, rowY + 13);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	private _frame(t: number): void {
		const gl = this._gl;
		const dt = Math.min((t - this._prevT) / 1000, 0.1) || 0.016;
		this._prevT = t;

		const dpr = Math.min(devicePixelRatio || 1, 2);
		const w = this._canvas.clientWidth,
			h = this._canvas.clientHeight;
		if (this._canvas.width !== w * dpr || this._canvas.height !== h * dpr) {
			this._canvas.width = w * dpr;
			this._canvas.height = h * dpr;
		}

		if (this._camTween) {
			const tw = this._camTween;
			const u = Math.min(1, (t - tw.t0) / tw.duration);
			const e = easeInOut(u);
			this.yaw = tw.from.yaw + (tw.to.yaw - tw.from.yaw) * e;
			this.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * e;
			this.dist = tw.from.dist + (tw.to.dist - tw.from.dist) * e;
			if (u >= 1) this._camTween = null;
		} else if (!this._dragging) {
			this.yaw += this._velYaw;
			this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + this._velPitch));
			this._velYaw *= 0.94;
			this._velPitch *= 0.94;
		}

		let spinning = false;
		if (this._spin) {
			spinning = true;
			if (this._spin.infinite) {
				this._dialAngle += this._spin.speed * dt;
			} else {
				const sp = this._spin;
				const u = Math.min(1, (t - sp.t0) / sp.duration);
				this._dialAngle = sp.from + (sp.to - sp.from) * easeInOut(u);
				if (u >= 1) this._spin = null;
			}
		}

		if (this._defaultUi && this._playing) {
			this._progress += dt;
			if (this._progress >= this._track.duration) this._progress = 0;
			if (t - this._lastUiUpdate > 400) {
				this._lastUiUpdate = t;
				this._drawDefaultUi();
				this.updateScreen();
			}
		}

		gl.viewport(0, 0, this._canvas.width, this._canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.DEPTH_TEST);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		const aspect = this._canvas.width / this._canvas.height;
		const proj = mat4Perspective(0.5, aspect, 10, 1200);
		const view = mat4Translate(0, 0, -this.dist);
		const rot = mat4Mul(mat4RotX(this.pitch), mat4RotY(this.yaw));
		const base = mat4Mul(proj, mat4Mul(view, rot));
		const baseNrm = mat3FromMat4(rot);
		const C = this._baseColors;

		this._drawLit(this._body, C.body, 0.35, base, baseNrm);
		this._drawLit(this._hump, C.hump, 0.3, base, baseNrm);
		this._drawLit(this._slot, this._flashColor('usb', C.slot), 0.4, base, baseNrm);
		this._drawLit(this._edgeTab, this._flashColor('tag', C.tab), 0.3, base, baseNrm);
		const keyNames: FlashTarget[] = ['preset1', 'preset2', 'preset3', 'preset4', 'settings'];
		for (let i = 0; i < this._keys.length; i++) {
			this._drawLit(this._keys[i], this._flashColor(keyNames[i], C.key), 0.3, base, baseNrm);
		}
		for (const m of this._mics) this._drawLit(m, C.mic, 0.1, base, baseNrm);

		const dialLocal = mat4Mul(
			mat4Translate(DIAL_X, DIAL_Y, BODY_D / 2 + DIAL_D / 2 - 1),
			mat4RotZ(this._dialAngle)
		);
		const dialMVP = mat4Mul(base, dialLocal);
		const dialNrm = mat3FromMat4(mat4Mul(rot, mat4RotZ(this._dialAngle)));
		this._drawLit(this._dial, this._flashColor('dial', C.dial), 0.12, dialMVP, dialNrm);
		if (spinning) {
			const dotMVP = mat4Mul(dialMVP, mat4Translate(0, DIAL_R - 4.5, DIAL_D / 2 + 0.1));
			this._drawLit(this._dialDot, [0.16, 0.165, 0.17], 0.2, dotMVP, dialNrm);
		}

		const backMVP = mat4Mul(base, mat4Translate(46, -17.5, BODY_D / 2 - 0.55));
		this._drawLit(this._backBtn, this._flashColor('back', C.back), 0.12, backMVP, baseNrm);

		gl.useProgram(this._texProg);
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenPosBuf);
		gl.enableVertexAttribArray(this._texLoc.aPos);
		gl.vertexAttribPointer(this._texLoc.aPos, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenUVBuf);
		gl.enableVertexAttribArray(this._texLoc.aUV);
		gl.vertexAttribPointer(this._texLoc.aUV, 2, gl.FLOAT, false, 0, 0);
		gl.uniformMatrix4fv(this._texLoc.uMVP, false, base);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this._tex);
		gl.uniform1i(this._texLoc.uTex, 0);
		gl.drawArrays(gl.TRIANGLES, 0, this._screenVerts);
	}

	private _drawLit(
		mesh: Mesh,
		color: RGB,
		gloss: number,
		mvp: Float32Array,
		nrm3: Float32Array
	): void {
		const gl = this._gl;
		gl.useProgram(this._litProg);
		gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuf);
		gl.enableVertexAttribArray(this._litLoc.aPos);
		gl.vertexAttribPointer(this._litLoc.aPos, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuf);
		gl.enableVertexAttribArray(this._litLoc.aNrm);
		gl.vertexAttribPointer(this._litLoc.aNrm, 3, gl.FLOAT, false, 0, 0);
		gl.uniformMatrix4fv(this._litLoc.uMVP, false, mvp);
		gl.uniformMatrix3fv(this._litLoc.uNrm, false, nrm3);
		gl.uniform3fv(this._litLoc.uColor, color);
		gl.uniform1f(this._litLoc.uGloss, gloss);
		gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
	}
}
