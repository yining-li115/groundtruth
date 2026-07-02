/**
 * LEGO-pixellation shader — ported from rock-biter/lego-pixellation (GitHub) to our R3F
 * stack (CLAUDE.md rule 9: rebuilt, not pasted). The original is plain three.js with .glsl
 * files + a ping-pong FBO mouse trail; here the GLSL is inlined as strings (we have no glsl
 * vite plugin) and the trail is simplified to a cursor disc (no FBO) that melts the bricks
 * back into the real photo near the pointer.
 *
 * How it works: the plane's UV is split into an N×N grid; each cell samples the face photo
 * at its centre to get that brick's colour, then an SDF draws a rounded LEGO brick with
 * lighting + specular. Perlin noise decides which bricks get a raised stud (with the "LEGO"
 * wordmark embossed via SDF letters). Near the cursor the cell reverts to the full-res photo.
 *
 * NOTE asset colours: this is a visual/WebGL asset, exempt from the token hex rule
 * (design-system §2 "Asset colors").
 */

/** Fullscreen plane: place the -1..1 quad straight in clip space, so it always fills the
 *  (square) canvas regardless of camera. */
export const legoVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const legoFragment = /* glsl */ `
  precision highp float;

  varying vec2 vUv;
  uniform sampler2D uAvatarTexture;
  uniform float uSubdivision;
  uniform float uLightAngle;
  uniform float uTime;
  uniform vec2  uCursor;      // cursor position in UV space (0..1)
  uniform float uCursorOn;    // 1 while the cursor is over the avatar, else 0
  uniform float uCursorRadius;

  float PI2 = 6.28318530718;

  // ---- Classic Perlin 3D noise (Stefan Gustavson / stegu webgl-noise) ----
  vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  vec3 fade(vec3 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }
  float cnoise(vec3 P){
    vec3 Pi0 = floor(P); vec3 Pi1 = Pi0 + vec3(1.0);
    Pi0 = mod(Pi0, 289.0); Pi1 = mod(Pi1, 289.0);
    vec3 Pf0 = fract(P); vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz; vec4 iz1 = Pi1.zzzz;
    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0); vec4 ixy1 = permute(ixy + iz1);
    vec4 gx0 = ixy0 / 7.0; vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
    gx0 = fract(gx0); vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5); gy0 -= sz0 * (step(0.0, gy0) - 0.5);
    vec4 gx1 = ixy1 / 7.0; vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
    gx1 = fract(gx1); vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5); gy1 -= sz1 * (step(0.0, gy1) - 0.5);
    vec3 g000 = vec3(gx0.x,gy0.x,gz0.x); vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
    vec3 g010 = vec3(gx0.z,gy0.z,gz0.z); vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
    vec3 g001 = vec3(gx1.x,gy1.x,gz1.x); vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
    vec3 g011 = vec3(gx1.z,gy1.z,gz1.z); vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);
    vec4 norm0 = taylorInvSqrt(vec4(dot(g000,g000), dot(g010,g010), dot(g100,g100), dot(g110,g110)));
    g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001,g001), dot(g011,g011), dot(g101,g101), dot(g111,g111)));
    g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);
    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000,n100,n010,n110), vec4(n001,n101,n011,n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    return 2.2 * mix(n_yz.x, n_yz.y, fade_xyz.x);
  }

  float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

  vec3 sdgCircle(in vec2 p, in float r){ float d = length(p); return vec3(d-r, p/d); }
  vec3 sdgBox(in vec2 p, in vec2 b){
    vec2 w = abs(p)-b; vec2 s = vec2(p.x<0.0?-1:1, p.y<0.0?-1:1);
    float g = max(w.x,w.y); vec2 q = max(w,0.0); float l = length(q);
    return vec3((g>0.0)?l:g, s*((g>0.0)?q/l:((w.x>w.y)?vec2(1,0):vec2(0,1))));
  }
  float sdSegment(in vec2 p, in vec2 a, in vec2 b){
    vec2 pa = p-a, ba = b-a; float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
    return length(pa - ba*h);
  }
  float sdArc(in vec2 p, in vec2 sc, in float ra, float rb){
    p.x = abs(p.x);
    return ((sc.y*p.x>sc.x*p.y) ? length(p-sc*ra) : abs(length(p)-ra)) - rb;
  }
  vec2 rotate2D(vec2 v, float angle){
    float c = cos(angle); float s = sin(angle);
    return vec2(v.x*c - v.y*s, v.x*s + v.y*c);
  }

  vec3 charL(in vec2 p, in vec2 a, in vec2 b, in vec2 c, in float r){
    float d1 = sdSegment(p, a, b); float d2 = sdSegment(p, b, c);
    return min(vec3(d1), vec3(d2)) - r;
  }
  vec3 charE(in vec2 p, in vec2 a, in vec2 b, in vec2 c, in float r){
    float h = a.y - b.y; float x = a.x - b.x;
    float d1 = sdSegment(p, a, b);
    float d2 = sdSegment(p, b, c);
    float d3 = sdSegment(p, b + vec2(x, h), c + vec2(x, h));
    float d4 = sdSegment(p, b + vec2(x*0.5, h*0.5), c + vec2(x*0.5, h*0.5));
    vec3 ch = min(vec3(d1), vec3(d2)); ch = min(ch, vec3(d3)); ch = min(ch, vec3(d4));
    return ch - r;
  }
  vec3 charO(in vec2 p, in vec2 a, in vec2 b, in float r){
    return vec3(abs(sdSegment(p, a, b) - r));
  }
  vec3 charG(in vec2 p, in vec2 a, in vec2 b, in float r){
    vec2 x = vec2(-0.069,0.0); vec2 y = vec2(0.0,0.01);
    vec2 c = a - x - vec2(a - b) * 0.5;
    float d1 = sdSegment(p, a + x + y, b + x + y);
    float d2 = sdSegment(p, c, b - x - y);
    float d3 = sdSegment(p, c, c + x * 0.6);
    float alpha = PI2 * 0.25;
    float a1 = sdArc(rotate2D(p - a, PI2 * 0.03), vec2(sin(alpha), cos(alpha)), 0.0695, 0.00);
    float a2 = sdArc(rotate2D(p - b, PI2 * 0.5 + PI2 * 0.03), vec2(sin(alpha), cos(alpha)), 0.0695, 0.00);
    float ch = min(d1,d2); ch = min(ch,d3); ch = min(ch,a1); ch = min(ch,a2);
    return vec3(ch) - r;
  }
  float lego(in vec2 uv, in vec2 l1, in vec2 l2, in vec2 l3, in vec2 e1, in vec2 e2, in vec2 e3, in vec2 g1, in vec2 g2, in vec2 o1, in vec2 o2, in float w, in float r){
    float letterL = charL(uv, l1, l2, l3, w).r;
    float letterE = charE(uv, e1, e2, e3, w).r;
    float letterG = charG(uv, g1, g2, w).r;
    float letterO = charO(uv, o1, o2, r).r;
    return min(min(letterL, letterE), min(letterG, letterO - w));
  }

  void main() {
    // Per-cell sample point (centre-ish of each brick) and the full-res photo.
    vec2 uvMap = floor(vUv * uSubdivision) / uSubdivision + 0.1 / uSubdivision;
    vec3 pixelColor = texture2D(uAvatarTexture, uvMap).rgb;   // blocky brick colour
    vec3 originalAvatar = texture2D(uAvatarTexture, vUv).rgb; // full-res, for the cursor melt

    // Cursor disc → "trail": 1 near the pointer, fading out by uCursorRadius.
    float trailV = uCursorOn * smoothstep(uCursorRadius, 0.0, distance(uvMap, uCursor));
    vec3 trail = vec3(trailV);

    float n = cnoise(vec3(uvMap * 10. + 100., uTime * 0.1));
    vec2 uv = fract(vUv * uSubdivision) * 2.0 - 1.0; // local coords inside a brick, -1..1
    vec3 color = vec3(1.0);

    vec2 lightDirection = rotate2D(vec2(1., 0.0), uLightAngle);
    vec3 light = vec3(0);

    float boxRadius = 0.07;
    float tBox = sdgBox(uv, vec2(1. - boxRadius)).x;
    float bt = smoothstep(0.0, -0.05, tBox - boxRadius);
    color = mix(vec3(0.2), color, pow(bt,0.5));

    float rtb = smoothstep(0.0, -0.07, tBox - boxRadius);
    rtb *= smoothstep(-0.3, 0., sdgBox(uv - lightDirection * 0.03, vec2(1.1)).x - 0.07);
    light += vec3(1.) * pow(abs(rtb), 3.) * 5.;

    if (trail.r > 0.5 || n > 0.5 || n < -0.5) {
      float tCircle = sdgCircle(uv, 0.99).x;
      float ct = smoothstep(0.0, 0.02, tCircle); ct += smoothstep(0.0, -0.05, tCircle);
      color = min(color, mix(vec3(0.3), color, pow(ct,0.5)));
      float rtc = smoothstep(0.0, -0.05, tCircle);
      rtc *= smoothstep(-0.3, 0., sdgCircle(uv - lightDirection * 0.08, 1.17).x);
      light += vec3(1.) * pow(rtc, 2.) * 1.;
    }

    if (n > 0. && trail.r < 0.3) {
      // raised stud
      float tCircle = sdgCircle(uv, 0.62).x;
      float ct = smoothstep(0.0, 0.02, tCircle); ct += smoothstep(0.0, -0.05, tCircle);
      color = min(color, mix(vec3(0.3), color, pow(ct,0.5)));
      float rtc = smoothstep(0.0, -0.05, tCircle);
      rtc *= smoothstep(-0.3, 0., sdgCircle(uv - lightDirection * 0.08, 0.85).x);
      light += vec3(1.) * pow(rtc, 2.) * 3.;
      // drop shadow of the stud
      float tLine = sdSegment(uv, vec2(0), lightDirection * 0.2);
      float lt = smoothstep(-0.01, 0.02, tLine - 0.63);
      vec3 shadowColor = mix(vec3(0.3), color, pow(lt,0.5));
      shadowColor += smoothstep(0.0, -0.0, sdgCircle(uv, 0.62).x);
      color = min(color, shadowColor);
      // embossed "LEGO" wordmark (its separate reflection pass — a 2nd full lego() SDF — is
      // dropped to roughly halve this branch's per-pixel cost; we fake the highlight from the
      // same word field instead).
      float word = lego(uv, vec2(-0.357,0.215), vec2(-0.452,-0.205), vec2(-0.31,-0.205), vec2(-0.138,0.215), vec2(-0.232,-0.205), vec2(-0.08,-0.205), vec2(0.15,0.15), vec2(0.085,-0.135), vec2(0.39,0.15), vec2(0.325,-0.135), 0.013, 0.068);
      float lw = smoothstep(0.0, 0.01, word); lw += smoothstep(0.0, -0.03, word);
      color = mix(vec3(0.6), color, pow(lw,0.5));
      light += vec3(1.) * smoothstep(0.0, -0.05, word) * 0.35;
    }

    color *= 1.0 + rand(vUv * 100.) * 0.3;
    vec3 legoColor = color * pixelColor + light * pixelColor * 8.;

    // Near the cursor, melt the brick back to the real (full-res) photo.
    vec3 outColor = mix(legoColor, originalAvatar, trail.r);

    // Alpha comes from the texture so a cut-out (transparent-background) portrait keeps its
    // transparency: the brick takes the cell-centre alpha, the cursor-melt the full-res alpha.
    // (For an opaque photo every alpha is 1, so nothing changes there.)
    float aBrick = texture2D(uAvatarTexture, uvMap).a;
    float aFull  = texture2D(uAvatarTexture, vUv).a;

    // Work entirely in the texture's stored (sRGB) space and write straight to the sRGB
    // drawing buffer — no decode/encode includes (a raw ShaderMaterial doesn't get their
    // GLSL deps injected, which would fail to compile).
    gl_FragColor = vec4(outColor, mix(aBrick, aFull, trail.r));
  }
`;
