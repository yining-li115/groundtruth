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
    fallbackColor: "#CCCCCC",
    accentColor: "#CCCCCC",
    textureSrc: POSTER,
    position: { x: 0.8, y: 0 },
    backgroundColor: "#CCCCCC", // gray.20 — start of the white→black depth descent
    blob1Color: "#FFFFFF", // light lift
    blob2Color: "#808080", // gray.50 soft shade — neutral, no chroma
    label: { title: "Semantic Segmentation", kind: "Master Thesis", color: "#2e2e2e" },
  },
  {
    fallbackColor: "#808080",
    accentColor: "#808080",
    textureSrc: POSTER,
    position: { x: -0.7, y: 0 },
    backgroundColor: "#808080", // gray.50
    blob1Color: "#CCCCCC", // gray.20 lift
    blob2Color: "#333333", // gray.80 shade
    label: { title: "Point Cloud Learning", kind: "Guided Research", color: "#f4f4f4" },
  },
  {
    fallbackColor: "#333333",
    accentColor: "#333333",
    textureSrc: POSTER,
    position: { x: 1, y: 0 },
    backgroundColor: "#333333", // gray.80
    blob1Color: "#808080", // gray.50 lift
    blob2Color: "#000000", // black shade
    label: { title: "Monocular Depth Estimation", kind: "Bachelor Thesis", color: "#f4f4f4" },
  },
  {
    fallbackColor: "#000000",
    accentColor: "#000000",
    textureSrc: POSTER,
    position: { x: -0.7, y: 0 },
    backgroundColor: "#000000", // brand.black — deepest
    blob1Color: "#333333", // gray.80 faint lift
    blob2Color: "#000000", // stays black
    label: { title: "Neural Scene Rendering", kind: "Master Thesis", color: "#f4f4f4" },
  },
];

export { galleryPlaneData };
