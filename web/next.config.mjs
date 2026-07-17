/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fonts load at runtime via <link> (Montserrat/Inter); skip build-time
  // font optimization which requires network access to Google Fonts.
  optimizeFonts: false,
};

export default nextConfig;
