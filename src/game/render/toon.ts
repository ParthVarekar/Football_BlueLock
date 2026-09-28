/**
 * Toon material factory + golden-hour light rig.
 *
 * The painted look rests on three tricks:
 *  1. A 4-step gradient ramp quantises direct sun into flat bands.
 *  2. The toon BRDF (lights_toon_pars_fragment) is patched so darker bands are
 *     HUE-SHIFTED toward a cool violet instead of just darker — coloured
 *     shadows, the heart of anime cel painting.
 *  3. A two-light anime setup (warm key + strong cool bounce from the opposite
 *     quarter, weak up-light, violet-grounded hemisphere) so the hue shift has
 *     something to colour.
 */
import * as THREE from 'three'
import { PALETTE, type Quality, QUALITY } from '../core/constants'

/** Shared uniforms so every toon material can be graded at once. */
export const TOON_UNIFORMS = {
  uShadowTint: { value: new THREE.Color('#8b7bd6') },
  uLightTint: { value: new THREE.Color('#fff3e2') },
}

/**
 * Patched lights_toon_pars_fragment. Same contract as three's chunk, but the
 * direct irradiance is tinted per band: dark bands lerp toward uShadowTint
 * (cool violet), bright bands toward uLightTint (warm paper white).
 */
const TOON_PARS = /* glsl */ `
varying vec3 vViewPosition;

struct ToonMaterial {
        vec3 diffuseColor;
};

uniform vec3 uShadowTint;
uniform vec3 uLightTint;

float toonBand( vec3 normal, vec3 lightDirection ) {
        float dotNL = dot( normal, lightDirection );
        vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
        #ifdef USE_GRADIENTMAP
                return texture2D( gradientMap, coord ).r;
        #else
                vec2 fw = fwidth( coord ) * 0.5;
                return mix( 0.7, 1.0, smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
        #endif
}

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
        float band = toonBand( geometryNormal, directLight.direction );
        vec3 tint = mix( uShadowTint, uLightTint, band );
        vec3 irradiance = vec3( band ) * tint * directLight.color;
        reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}

void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
        reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}

#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
`

let sharedRamp: THREE.DataTexture | null = null

/** 4-band hand-authored ramp: quantise direct light into flat steps. */
export function getToonRamp(): THREE.DataTexture {
  if (sharedRamp) return sharedRamp
  const bands = new Uint8Array([96, 150, 205, 255]) // 0.38 / 0.59 / 0.80 / 1.0
  const tex = new THREE.DataTexture(bands, bands.length, 1, THREE.RedFormat)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  sharedRamp = tex
  return tex
}

export interface ToonOpts {
  color?: THREE.ColorRepresentation
  map?: THREE.Texture | null
  emissive?: THREE.ColorRepresentation
  emissiveIntensity?: number
  transparent?: boolean
  opacity?: number
  alphaMap?: THREE.Texture | null
  alphaTest?: number
  side?: THREE.Side
  vertexColors?: boolean
  depthWrite?: boolean
  fog?: boolean
}

/** Patched MeshToonMaterial — use for everything that receives sun. */
export function makeToonMaterial(opts: ToonOpts = {}): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    color: opts.color ?? '#ffffff',
    map: opts.map ?? null,
    emissive: opts.emissive !== undefined ? new THREE.Color(opts.emissive) : new THREE.Color('#000000'),
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    alphaMap: opts.alphaMap ?? null,
    alphaTest: opts.alphaTest ?? 0,
    side: opts.side ?? THREE.FrontSide,
    vertexColors: opts.vertexColors ?? false,
    depthWrite: opts.depthWrite ?? true,
    fog: opts.fog ?? true,
  })
  if (opts.emissiveIntensity !== undefined) mat.emissiveIntensity = opts.emissiveIntensity
  mat.gradientMap = getToonRamp()
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uShadowTint = TOON_UNIFORMS.uShadowTint
    shader.uniforms.uLightTint = TOON_UNIFORMS.uLightTint
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_toon_pars_fragment>', TOON_PARS)
  }
  mat.customProgramCacheKey = () => 'gg-toon-v1'
  return mat
}

export interface LightRig {
  group: THREE.Group
  sun: THREE.DirectionalLight
  fill: THREE.DirectionalLight
  up: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** 0..1 across a full match: the sun sinks and swings so shadows stretch. */
  setSunProgress(p: number): void
  /** Re-tune shadow resolution at runtime (graphics settings). */
  setShadowSize(px: number): void
  dispose(): void
}

export function createLights(scene: THREE.Scene, quality: Quality): LightRig {
  const group = new THREE.Group()
  scene.add(group)

  // Warm golden-hour key, low over the pitch, the only shadow caster.
  const sun = new THREE.DirectionalLight('#ffd9a3', 2.7)
  sun.castShadow = true
  const shadowSize = QUALITY[quality].shadowMap
  sun.shadow.mapSize.set(shadowSize, shadowSize)
  const cam = sun.shadow.camera
  cam.left = -58
  cam.right = 58
  cam.top = 42
  cam.bottom = -42
  cam.near = 10
  cam.far = 240
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.035
  group.add(sun)
  group.add(sun.target)

  // Strong cool bounce from the opposite quarter — colours the shadow side.
  const fill = new THREE.DirectionalLight('#8f7fe8', 1.05)
  fill.position.set(-60, 34, -46)
  group.add(fill)
  group.add(fill.target)

  // Weak warm up-light (ground bounce).
  const up = new THREE.DirectionalLight('#ffb37a', 0.38)
  up.position.set(6, -24, 10)
  group.add(up)
  group.add(up.target)

  // Hemisphere with a violet ground colour — ambient hue variation.
  const hemi = new THREE.HemisphereLight('#ffe3c2', '#5e4f9e', 0.52)
  group.add(hemi)

  let progress = 0
  const baseDir = new THREE.Vector3(1, 0.36, 0.42).normalize()
  const tmp = new THREE.Vector3()

  const apply = () => {
    // Elevation sags 0.36 -> 0.20 and azimuth swings ~0.22 rad as the match runs.
    const el = THREE.MathUtils.lerp(0.36, 0.2, progress)
    const az = THREE.MathUtils.lerp(0, 0.22, progress)
    tmp.copy(baseDir).applyAxisAngle(new THREE.Vector3(0, 1, 0), az)
    tmp.y = 0
    tmp.normalize().multiplyScalar(Math.cos(el) * 105)
    tmp.y = Math.sin(el) * 105
    sun.position.copy(tmp)
    sun.target.position.set(0, 0, 0)
    sun.target.updateMatrixWorld()
  }
  apply()

  return {
    group,
    sun,
    fill,
    up,
    hemi,
    setSunProgress(p: number) {
      progress = THREE.MathUtils.clamp(p, 0, 1)
      apply()
    },
    setShadowSize(px: number) {
      const n = Math.max(512, Math.min(2048, Math.round(px)))
      sun.shadow.mapSize.set(n, n)
      if (sun.shadow.map) {
        sun.shadow.map.dispose()
        sun.shadow.map = null as unknown as THREE.WebGLRenderTarget
      }
    },
    dispose() {
      scene.remove(group)
      sun.dispose()
      fill.dispose()
      up.dispose()
      hemi.dispose()
    },
  }
}

/** Convenience: hero-ink colour for outlines. */
export const OUTLINE_INK: string = '#3a2e28'
