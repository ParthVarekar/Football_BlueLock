/**
 * Procedural animated sky — a golden-hour shader dome with flowing clouds.
 *
 * Everything is computed in the fragment shader from the view direction
 * `normalize(vWorld - cameraPosition)`, so the sky is inherently seamless at
 * the zenith and the horizon (no sphere-UV pole pinch, no wrap seams, no
 * painted halo rings). The dome rides along with the camera in xz every frame,
 * so the horizon never parallaxes.
 *
 * Layers, back to front:
 *   1. Hand-wobbled multi-stop golden-hour ramp (indigo-violet zenith → violet
 *      → rose → amber → gold horizon → warm dust haze below that matches the
 *      scene fog).
 *   2. Sun: hot ~2.6° disc + a wide soft warm glow built purely from smooth
 *      powers of the sun dot product — monotone falloff, guaranteed ring-free.
 *   3. Cirrus veil: anisotropic (6:1) fbm wisps on a higher, slower slab.
 *   4. Flowing cumulus: fbm value noise on the planar projection
 *      d.xz / (d.y + 0.24), drifting with the wind, posterized into three
 *      painterly bands and lit by a sun-offset fbm sample (warm tops, pink
 *      bodies, mauve undersides).
 *   5. Horizon haze band melting into the fog colour.
 *   6. ±1/255 hash dither to kill gradient banding.
 *
 * A tiny flock of dark chevron birds circles the dome (flap = scale.y wobble),
 * hidden on low quality. All colours arrive as uniforms in linear space
 * (THREE.Color converts), matching the game's linear grade pipeline.
 */
import * as THREE from 'three'
import { PALETTE, type Quality } from '../core/constants'

export interface SkyModule {
  readonly group: THREE.Group
  /** Advance cloud drift + bird flock; dome recentres on the camera xz. */
  update(dt: number, elapsed: number, camX: number, camZ: number): void
  /** low = 3 octaves / no cirrus / no birds · medium = 4 / cirrus · high = 5 / cirrus / birds. */
  setQuality(q: Quality): void
  /**
   * Pin the painted sun to the scene's key light. world.ts feeds the live
   * directional-light direction every frame so the sky sun, the shading and
   * the shadows always agree (toon.ts also sags the light as matches progress).
   */
  setSunDir(dir: THREE.Vector3): void
  dispose(): void
}

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vWorld;

uniform float uTime;
uniform vec3 uSunDir;      // unit vector toward the sun (mirrors the key light)
uniform vec3 uFogColor;    // PALETTE.fog — warm dust haze below the horizon
uniform int uOctaves;      // 3 (low) / 4 (medium) / 5 (high)
uniform float uCirrus;     // 0 (low) / 1 (medium + high)
uniform vec3 uZenith;      // deep indigo-violet
uniform vec3 uViolet;      // violet
uniform vec3 uRose;        // rose
uniform vec3 uAmber;       // amber
uniform vec3 uGold;        // gold horizon
uniform vec3 uSunCore;     // hot near-white disc
uniform vec3 uGlow;        // wide warm glow
uniform vec3 uCloudTop;    // sun-warmed tops
uniform vec3 uCloudBody;   // pink-lavender bodies
uniform vec3 uCloudUnder;  // mauve undersides
uniform vec3 uCirrusTint;  // warm thin wisps

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Quintic-smoothed value noise — soft blobs, no grid artefacts.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// fbm with a runtime octave count — quality switch without a recompile.
// Each octave also drifts a touch faster than the one below (wind shear), so
// cloud silhouettes slowly re-shape as they travel instead of sliding rigidly.
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  vec2 shear = vec2(1.0, 0.22) * uTime * 0.0012;
  for (int i = 0; i < 5; i++) {
    if (i >= uOctaves) break;
    v += amp * vnoise(p);
    p = p * 2.04 + vec2(11.7, 5.3) + shear * float(i);
    amp *= 0.55;
  }
  return v;
}

void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  float h = d.y;
  float az = atan(d.x, d.z);

  // ---- painted golden-hour ramp --------------------------------------------
  // Only integer harmonics of the azimuth (seam-free across the atan wrap) hand-
  // wobble the band heights; the sun side sags so the gold hugs the light.
  vec2 sunXZ = normalize(uSunDir.xz + vec2(1e-4, 1e-4));
  float sunSide = dot(normalize(d.xz + vec2(1e-4, 1e-4)), sunXZ) * 0.5 + 0.5;
  float wobble = 0.016 * sin(az * 2.0 + 1.7) + 0.010 * sin(az * 3.0 - 0.6) + 0.007 * sin(az * 5.0 + 2.9);
  float sag = (sunSide - 0.5) * 0.10 * (1.0 - smoothstep(0.05, 0.45, h));
  float hg = h + wobble - sag;

  vec3 c = uZenith;
  c = mix(c, uViolet, 1.0 - smoothstep(0.44, 0.93, hg));
  c = mix(c, uRose, 1.0 - smoothstep(0.10, 0.47, hg));
  c = mix(c, uAmber, 1.0 - smoothstep(0.015, 0.18, hg));
  c = mix(c, uGold, 1.0 - smoothstep(-0.05, 0.055, hg));
  // below the horizon: warm dust haze that melts into the ground fog
  c = mix(c, uFogColor, 1.0 - smoothstep(-0.32, -0.012, hg));

  // faint paint mottle on a seam-free domain (d.xz is continuous everywhere)
  c *= 1.0 + (vnoise(d.xz * 3.2 + vec2(4.7, 1.3)) - 0.5) * 0.05;

  // ---- sun: hot disc + wide soft glow, monotone falloff (no rings) ---------
  float sunCos = dot(d, uSunDir);
  float m = max(sunCos, 0.0);
  float glow = pow(m, 6.0) * 0.16 + pow(m, 32.0) * 0.28 + pow(m, 350.0) * 0.5;
  c += uGlow * glow;
  float disc = smoothstep(0.99885, 0.99930, sunCos);
  c = mix(c, uSunCore, disc);

  // ---- flowing cumulus ------------------------------------------------------
  // Project rays onto an overhead slab: p tracks the world xz of the cloud
  // material we see, so the wind is just a translating domain.
  float dy = max(h, 0.02);
  vec2 p = d.xz / (dy + 0.24);
  p *= 1.25;
  p += uTime * 0.012 * vec2(1.0, 0.22); // wind, roughly +X

  float n = fbm(p);
  // coverage-shaped density, posterized into three painterly bands
  float dens = smoothstep(0.50, 0.74, n);
  float d3 = dens * 3.0;
  float bandF = smoothstep(0.30, 0.70, fract(d3));
  float poster = (floor(d3) + bandF) / 3.0;

  // light: sample the slab slightly toward the sun — sun-facing flanks glow
  float nSun = fbm(p + sunXZ * 0.30);
  float lit = clamp(0.5 + (n - nSun) * 3.4, 0.0, 1.0);

  vec3 cloudCol = mix(uCloudUnder, uCloudBody, smoothstep(0.10, 0.60, lit));
  cloudCol = mix(cloudCol, uCloudTop, smoothstep(0.58, 0.95, lit));
  cloudCol += uGlow * pow(m, 14.0) * 0.20; // warm rim near the sun

  // rich mid sky; thin out very near the zenith and below the horizon line
  float zenFade = 1.0 - smoothstep(0.55, 0.90, h);
  float horFade = smoothstep(-0.03, 0.10, h);
  float cloudA = poster * (1.25 - 0.40 * poster) * zenFade * horFade;

  // ---- cirrus veil (medium + high quality) ---------------------------------
  vec2 cp = d.xz / max(h + 0.55, 0.10); // higher, slower slab
  cp += uTime * 0.0022 * vec2(1.0, 0.10);
  float ca = cos(0.62);
  float sa = sin(0.62);
  vec2 rc = vec2(cp.x * ca - cp.y * sa, cp.x * sa + cp.y * ca);
  float cn = fbm(vec2(rc.x, rc.y * 6.0) * 1.3 + vec2(3.7, 8.2)); // 6:1 streaks
  float cirr = smoothstep(0.56, 0.80, cn) * 0.18;
  cirr *= (1.0 - smoothstep(0.72, 0.97, h)) * smoothstep(-0.02, 0.14, h) * uCirrus;

  // ---- composite: ramp → sun → cirrus → cumulus → horizon haze --------------
  c = mix(c, uCirrusTint, cirr);
  c = mix(c, cloudCol, cloudA);

  float haze = (1.0 - smoothstep(-0.01, 0.17, h)) * 0.62;
  c = mix(c, uFogColor, haze);

  // ---- dither: ±1/255 hash grain kills gradient banding --------------------
  c += (hash12(gl_FragCoord.xy) - 0.5) * (2.0 / 255.0);

  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}
`

/** Chevron bird: two triangles with raised tips (dihedral) — scale.y = flap. */
function makeBirdGeometry(): THREE.BufferGeometry {
  const verts = new Float32Array([
    // left wing: tip, leading centre, trailing centre
    -0.62, 0.22, 0.04, 0.0, 0.0, 0.16, 0.0, 0.0, -0.1,
    // right wing
    0.62, 0.22, 0.04, 0.0, 0.0, -0.1, 0.0, 0.0, 0.16,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  return geo
}

export function createSky(): SkyModule {
  const group = new THREE.Group()

  // Default mirrors toon.ts createLights() at sun progress 0 (el 0.36, az 0):
  // horizontal (1, 0.42) normalised, tilted up by 0.36 rad.
  const horiz = new THREE.Vector3(1, 0, 0.42).normalize()
  const sunDir = new THREE.Vector3(horiz.x * Math.cos(0.36), Math.sin(0.36), horiz.z * Math.cos(0.36)).normalize()

  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDir },
    uFogColor: { value: new THREE.Color(PALETTE.fog) },
    uOctaves: { value: 5 },
    uCirrus: { value: 1 },
    uZenith: { value: new THREE.Color('#2c2a55') },
    uViolet: { value: new THREE.Color('#5a4a7a') },
    uRose: { value: new THREE.Color('#c96f6a') },
    uAmber: { value: new THREE.Color('#f5a35c') },
    uGold: { value: new THREE.Color('#ffd98f') },
    uSunCore: { value: new THREE.Color('#fff4d6') },
    uGlow: { value: new THREE.Color('#ffc98a') },
    uCloudTop: { value: new THREE.Color('#ffd9a0') },
    uCloudBody: { value: new THREE.Color('#f2c4c9') },
    uCloudUnder: { value: new THREE.Color('#a47d9e') },
    uCirrusTint: { value: new THREE.Color('#f7d9c4') },
  }

  const domeMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    depthTest: true,
  })
  const domeGeo = new THREE.SphereGeometry(460, 48, 32)
  const dome = new THREE.Mesh(domeGeo, domeMat)
  dome.renderOrder = -10
  dome.frustumCulled = false
  group.add(dome)

  // ---- bird flock: 5 dark chevrons on a slow high circuit around the dome
  const birdGeo = makeBirdGeometry()
  const birdMat = new THREE.MeshBasicMaterial({ color: '#3a2030', fog: false, side: THREE.DoubleSide })
  const birdFlock = new THREE.Group()
  const BIRD_R = 322
  const birds: Array<{ mesh: THREE.Mesh; a: number; speed: number; r: number; phase: number; flapHz: number }> = []
  for (let i = 0; i < 5; i++) {
    const mesh = new THREE.Mesh(birdGeo, birdMat)
    mesh.scale.setScalar(3.7)
    birdFlock.add(mesh)
    birds.push({
      mesh,
      a: 0.8 + i * 0.062 + (i % 2) * 0.03,
      speed: 0.026 + i * 0.0014,
      r: BIRD_R + (i - 2) * 16,
      phase: i * 1.7,
      flapHz: 2.3 + i * 0.19,
    })
  }
  group.add(birdFlock)

  const look = new THREE.Vector3()

  const update = (dt: number, elapsed: number, camX: number, camZ: number): void => {
    uniforms.uTime.value = elapsed
    // the whole sky rides with the camera — zero parallax at the horizon
    group.position.set(camX, 0, camZ)

    for (const b of birds) {
      b.a += b.speed * dt
      const x = Math.cos(b.a) * b.r
      const z = Math.sin(b.a) * b.r * 0.78
      const y = 146 + Math.sin(b.a * 2.0 + b.phase) * 17
      b.mesh.position.set(x, y, z)
      // face along the tangent of the circuit
      look.set(x - Math.sin(b.a) * 12, y + Math.cos(b.a * 2.0 + b.phase) * 3.4, z + Math.cos(b.a) * 0.78 * 12)
      b.mesh.lookAt(look)
      b.mesh.rotateZ(Math.sin(b.a * 2.0 + b.phase) * 0.34) // bank into the swells
      // wing flap: fold / open the dihedral V
      b.mesh.scale.y = 3.7 * (0.3 + Math.abs(Math.sin(elapsed * b.flapHz + b.phase)) * 0.9)
    }
  }

  return {
    group,
    update,
    setQuality(q: Quality) {
      uniforms.uOctaves.value = q === 'low' ? 3 : q === 'medium' ? 4 : 5
      uniforms.uCirrus.value = q === 'low' ? 0 : 1
      birdFlock.visible = q === 'high'
    },
    setSunDir(dir: THREE.Vector3) {
      uniforms.uSunDir.value.copy(dir).normalize()
    },
    dispose() {
      domeGeo.dispose()
      domeMat.dispose()
      birdGeo.dispose()
      birdMat.dispose()
      group.clear()
    },
  }
}
