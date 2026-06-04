/**
 * Point-cloud morph shader.
 * - position = scattered start, aTarget = surface target; uProgress (scroll) blends them.
 * - aSize = per-point random size factor (varied dust sizes).
 * - aColor = per-point color (zoned per building so structure reads).
 * - gl_PointSize divides by view-space depth → camera-distance attenuation.
 * - fragment samples a soft Gaussian sprite (uMap) for feathered dust.
 */
export const POINT_VERT = /* glsl */ `
  uniform float uProgress;
  uniform float uSize;
  attribute vec3 aTarget;
  attribute float aRand;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float t = clamp((uProgress - aRand * 0.25) / 0.75, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 p = mix(position, aTarget, t);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aSize * (320.0 / -mv.z);
    // low per-point alpha → dense areas build up dark, sparse/dispersing areas stay light
    vAlpha = 0.3 + 0.2 * t;
    vColor = aColor;
  }
`;

export const POINT_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float m = texture2D(uMap, gl_PointCoord).a; // soft Gaussian falloff
    gl_FragColor = vec4(vColor, m * vAlpha);
  }
`;
