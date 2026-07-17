import type { Config } from "tailwindcss";

/**
 * automators-brand v2 tokens — one visual family across the platform.
 * brand.blue #0057FF · brand.navy #1E2430 · brand.cyan #00E5FF
 * Headings: Montserrat · Body: Inter
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        brand: {
          blue: "#0057FF",
          navy: "#1E2430",
          cyan: "#00E5FF",
          50: "#eaf1ff",
          100: "#d5e3ff",
          200: "#adc7ff",
          300: "#7ea3ff",
          400: "#4d7bff",
          500: "#0057FF",
          600: "#0046cc",
          700: "#0037a3",
          800: "#062b7a",
          900: "#0a2560",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        heading: ["var(--font-montserrat)", "Montserrat", "var(--font-inter)", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
