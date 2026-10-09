/**
 * Brand images from public/brand. Relative to the app's base (`./` in builds), so they also load
 * when the desktop app serves the bundle from file:// (an absolute `/brand/...` does not).
 */
export const BRAND_MARK = `${import.meta.env.BASE_URL}brand/archai-mark.png`;
