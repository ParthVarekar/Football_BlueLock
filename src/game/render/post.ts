/**
 * Final grade pass — the "painting" happens here.
 *
 * Scene renders into an offscreen target (MSAA on strong GPUs), then a single
 * fullscreen pass applies: soft S-curve, split-tone (violet darks / warm
 * paper-white highlights), lifted blacks, paper grain, gentle vignette, and the
 * sRGB transfer. NO bloom, NO glow, NO neon — this is a painting.
 *
 * EGO supers lean on the same pass, still in print terms: a storm grade
 * (Thunder Seal), a sepia ink monochrome (Zero Hour), a two-tone ink
 * "impact frame" (the manga beat on a big hit) and a colour wash.
 */
import * as THREE from 'three'
import { type Quality, QUALITY } from '../core/constants'

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
        vUv = uv;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform float uStorm;
uniform float uMono;
uniform float uInk;
uniform vec3 uWash;
uniform float uWashAmt;
uniform float uFocus;

float hash( vec2 p ) {
        return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}

vec3 toSRGB( vec3 c ) {
        vec3 lo = c * 12.92;
        vec3 hi = pow( max( c, vec3( 0.0 ) ), vec3( 0.41666 ) ) * 1.055 - 0.055;
        return mix( lo, hi, step( vec3( 0.0031308 ), c ) );
}

void main() {
        vec3 c = texture2D( tDiffuse, vUv ).rgb;

        // exposure + soft S-curve (filmic-ish, keeps highlights paper-like)
        c = clamp( c * 1.07, 0.0, 1.0 );
        c = c * c * ( 3.0 - 2.0 * c ) * 0.34 + c * 0.72;

        // split-tone: violet shadows, warm paper highlights
        float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
        vec3 shadowTint = vec3( 0.80, 0.72, 1.10 );
        vec3 highTint = vec3( 1.06, 1.00, 0.88 );
        c *= mix( shadowTint, highTint, smoothstep( 0.10, 0.72, l ) );

        // lifted blacks — a print, not a render
        c = c * ( 1.0 - 0.06 ) + vec3( 0.055, 0.050, 0.078 );

        // paper grain
        float g = hash( vUv * uRes + vec2( fract( uTime * 61.7 ) * 919.0, fract( uTime * 43.3 ) * 713.0 ) );
        c += ( g - 0.5 ) * uGrain;

        // ---- EGO supers ----------------------------------------------
        // colour wash (dragon crimson, cyclone blossom…) multiplied like a glaze
        c = mix( c, c * uWash * 1.25, uWashAmt );

        // storm: the golden hour drains to bruised violet, darks sink
        float ls = dot( c, vec3( 0.299, 0.587, 0.114 ) );
        vec3 storm = mix( vec3( ls ) * vec3( 0.62, 0.6, 0.86 ), c * vec3( 0.7, 0.68, 0.95 ), 0.35 );
        c = mix( c, storm, uStorm );

        // Zero Hour: sepia ink print — paper highlights, umber darks, hatch in the shadows
        float lm = dot( c, vec3( 0.299, 0.587, 0.114 ) );
        vec3 ink = vec3( 0.19, 0.155, 0.14 );
        vec3 paper = vec3( 0.97, 0.92, 0.82 );
        vec3 sepia = mix( ink, paper, smoothstep( 0.08, 0.86, lm ) );
        vec2 px = vUv * uRes;
        float hatch = step( 0.5, fract( ( px.x + px.y ) / 7.0 ) ) * ( 1.0 - smoothstep( 0.18, 0.42, lm ) );
        sepia = mix( sepia, ink, hatch * 0.35 );
        c = mix( c, sepia, uMono );

        // impact frame: hard two-tone ink, inverted (paper lines on ink)
        float li = dot( c, vec3( 0.299, 0.587, 0.114 ) );
        vec3 two = mix( vec3( 0.97, 0.93, 0.84 ), vec3( 0.16, 0.12, 0.11 ), step( 0.46, li ) );
        c = mix( c, two, uInk );

        // gentle vignette (tightens into a focus tunnel during cut-ins)
        vec2 q = vUv - 0.5;
        c *= 1.0 - ( uVignette + uFocus * 0.9 ) * dot( q, q ) * 1.7;

        gl_FragColor = vec4( toSRGB( max( c, vec3( 0.0 ) ) ), 1.0 );
}
`

export class GradePass {
  private readonly renderer: THREE.WebGLRenderer
  private rt: THREE.WebGLRenderTarget
  private readonly quadScene: THREE.Scene
  private readonly quadCam: THREE.OrthographicCamera
  private readonly mat: THREE.ShaderMaterial
  private disposed = false

  constructor(renderer: THREE.WebGLRenderer, quality: Quality) {
    this.renderer = renderer
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.rt = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), {
      samples: QUALITY[quality].msaa,
      depthBuffer: true,
    })
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uRes: { value: new THREE.Vector2(Math.max(2, size.x), Math.max(2, size.y)) },
        uTime: { value: 0 },
        uGrain: { value: quality === 'high' ? 0.016 : 0.024 },
        uVignette: { value: 0.24 },
        uStorm: { value: 0 },
        uMono: { value: 0 },
        uInk: { value: 0 },
        uWash: { value: new THREE.Color(1, 1, 1) },
        uWashAmt: { value: 0 },
        uFocus: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    })
    this.quadScene = new THREE.Scene()
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat)
    quad.frustumCulled = false
    this.quadScene.add(quad)
  }

  setSize(width: number, height: number): void {
    if (this.disposed) return
    this.rt.setSize(Math.max(2, width), Math.max(2, height))
    this.mat.uniforms.uRes.value.set(Math.max(2, width), Math.max(2, height))
  }

  /** Rebuild the MSAA target (graphics settings, runtime). */
  setSamples(samples: number): void {
    if (this.disposed) return
    const next = new THREE.WebGLRenderTarget(Math.max(2, this.rt.width), Math.max(2, this.rt.height), {
      samples: Math.max(0, Math.min(4, Math.round(samples))),
      depthBuffer: true,
    })
    this.rt.dispose()
    this.rt = next
    this.mat.uniforms.tDiffuse.value = next.texture
  }

  /**
   * Super-move grading, all 0..1: storm (Thunder Seal), mono (Zero Hour),
   * ink (impact frame), a colour wash and the cut-in focus tunnel.
   */
  setSuperFx(fx: { storm: number; mono: number; ink: number; wash: THREE.Color; washAmt: number; focus: number }): void {
    const u = this.mat.uniforms
    u.uStorm.value = fx.storm
    u.uMono.value = fx.mono
    u.uInk.value = fx.ink
    ;(u.uWash.value as THREE.Color).copy(fx.wash)
    u.uWashAmt.value = fx.washAmt
    u.uFocus.value = fx.focus
  }

  /** Paper grain weight (graphics settings). */
  setGrain(g: number): void {
    this.mat.uniforms.uGrain.value = g
  }

  render(scene: THREE.Scene, camera: THREE.Camera, time: number): void {
    if (this.disposed) return
    this.mat.uniforms.uTime.value = time
    const renderer = this.renderer
    renderer.setRenderTarget(this.rt)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.clear()
    renderer.render(this.quadScene, this.quadCam)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rt.dispose()
    this.mat.dispose()
    ;(this.quadScene.children[0] as THREE.Mesh).geometry.dispose()
  }
}

/** Creates the WebGL renderer with the right tone-mapping / color pipeline. */
export function createGameRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // MSAA happens on the grade target
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping // grading is hand-rolled in the final pass
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(new THREE.Color('#f2ddbe'), 1)
  return renderer
}
