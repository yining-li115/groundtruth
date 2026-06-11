// @ts-nocheck — vendored port of Codrops depth-gallery (houmahani/codrops-depth-gallery, MIT)
// Open-topic posters live in public/media/depth/. Each plane carries a "mood" (background + blob
// colors) that the GLSL background blends to as the camera passes, plus a label (topic + kind).
const POSTER = "/media/depth/poster.webp";

const galleryPlaneData = [
  {
    fallbackColor: "#feca4f",
    accentColor: "#feca4f",
    textureSrc: POSTER,
    position: { x: -0.9, y: 0 },
    // NOTE: this raw-ShaderMaterial background writes gl_FragColor without sRGB output encoding,
    // so an input hex displays ~6 levels darker than its sRGB value. To land the entry exactly on
    // the page background (#F7F6FB / theme.light.bg), the input is pre-brightened to compensate.
    backgroundColor: "#FAFAFD", // displays ≈ #F7F6FB → blends seamlessly with the home page
    blob1Color: "#FFFFFF", // light glow only — brighter than the base, never darker/tinted
    blob2Color: "#FFFFFF",
    label: { title: "3D Reconstruction", kind: "Master Thesis", color: "#2e2e2e" },
  },
  {
    fallbackColor: "#80455a",
    accentColor: "#80455a",
    textureSrc: POSTER,
    position: { x: 0.8, y: 0 },
    backgroundColor: "#fffaf0",
    blob1Color: "#d29a41",
    blob2Color: "#bb96af",
    label: { title: "Semantic Segmentation", kind: "Master Thesis", color: "#2e2e2e" },
  },
  {
    fallbackColor: "#fa7b71",
    accentColor: "#fa7b71",
    textureSrc: POSTER,
    position: { x: -0.7, y: 0 },
    backgroundColor: "#5f81ab",
    blob1Color: "#f88b8d",
    blob2Color: "#cfbbdd",
    label: { title: "Point Cloud Learning", kind: "Guided Research", color: "#f4f4f4" },
  },
  {
    fallbackColor: "#3c72c6",
    accentColor: "#3c72c6",
    textureSrc: POSTER,
    position: { x: 1, y: 0 },
    backgroundColor: "#5b9bc2",
    blob1Color: "#ffaa00",
    blob2Color: "#00e1ff",
    label: { title: "Monocular Depth Estimation", kind: "Bachelor Thesis", color: "#f4f4f4" },
  },
  {
    fallbackColor: "#fdd895",
    accentColor: "#fdd895",
    textureSrc: POSTER,
    position: { x: -0.7, y: 0 },
    backgroundColor: "#7d936e",
    blob1Color: "#fdd895",
    blob2Color: "#a5b599",
    label: { title: "Neural Scene Rendering", kind: "Master Thesis", color: "#f4f4f4" },
  },
];

export { galleryPlaneData };
